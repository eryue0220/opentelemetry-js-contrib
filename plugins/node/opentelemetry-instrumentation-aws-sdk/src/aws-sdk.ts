/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  Span,
  SpanKind,
  context,
  trace,
  diag,
  SpanStatusCode,
} from '@opentelemetry/api';
import { hrTime, suppressTracing } from '@opentelemetry/core';
import { AttributeNames } from './enums';
import { ServicesExtensions } from './services';
import {
  AwsSdkInstrumentationConfig,
  AwsSdkRequestHookInformation,
  AwsSdkResponseHookInformation,
  NormalizedRequest,
  NormalizedResponse,
} from './types';
/** @knipignore */
import { PACKAGE_NAME, PACKAGE_VERSION } from './version';
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
  safeExecuteInTheMiddle,
} from '@opentelemetry/instrumentation';
import type {
  MiddlewareStack,
  HandlerExecutionContext,
  Command as AwsV3Command,
  Handler as AwsV3MiddlewareHandler,
  InitializeHandlerArguments,
} from '@aws-sdk/types';
import {
  bindPromise,
  extractAttributesFromNormalizedRequest,
  normalizeV3Request,
  removeSuffixFromStringIfExists,
} from './utils';
import { propwrap } from './propwrap';
import { RequestMetadata } from './services/ServiceExtension';
import { SEMATTRS_HTTP_STATUS_CODE } from '@opentelemetry/semantic-conventions';

const V3_CLIENT_CONFIG_KEY = Symbol(
  'opentelemetry.instrumentation.aws-sdk.client.config'
);
type V3PluginCommand = AwsV3Command<any, any, any, any, any> & {
  [V3_CLIENT_CONFIG_KEY]?: any;
};

export class AwsInstrumentation extends InstrumentationBase<AwsSdkInstrumentationConfig> {
  static readonly component = 'aws-sdk';
  // need declare since initialized in callbacks from super constructor
  private declare servicesExtensions: ServicesExtensions;

  constructor(config: AwsSdkInstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, config);
  }

  protected init(): InstrumentationModuleDefinition[] {
    const v3MiddlewareStackFileOldVersions = new InstrumentationNodeModuleFile(
      '@aws-sdk/middleware-stack/dist/cjs/MiddlewareStack.js',
      ['>=3.1.0 <3.35.0'],
      this.patchV3ConstructStack.bind(this),
      this.unpatchV3ConstructStack.bind(this)
    );
    const v3MiddlewareStackFileNewVersions = new InstrumentationNodeModuleFile(
      '@aws-sdk/middleware-stack/dist-cjs/MiddlewareStack.js',
      ['>=3.35.0'],
      this.patchV3ConstructStack.bind(this),
      this.unpatchV3ConstructStack.bind(this)
    );

    // as for aws-sdk v3.13.1, constructStack is exported from @aws-sdk/middleware-stack as
    // getter instead of function, which fails shimmer.
    // so we are patching the MiddlewareStack.js file directly to get around it.
    const v3MiddlewareStack = new InstrumentationNodeModuleDefinition(
      '@aws-sdk/middleware-stack',
      ['^3.1.0'],
      undefined,
      undefined,
      [v3MiddlewareStackFileOldVersions, v3MiddlewareStackFileNewVersions]
    );

    // Patch for @smithy/middleware-stack for @aws-sdk/* packages v3.363.0+.
    // As of @smithy/middleware-stack@2.1.0 `constructStack` is only available
    // as a getter, so we cannot use `this._wrap()`.
    const self = this;
    const v3SmithyMiddlewareStack = new InstrumentationNodeModuleDefinition(
      '@smithy/middleware-stack',
      ['>=2.0.0'],
      (moduleExports, moduleVersion) => {
        const newExports = propwrap(
          moduleExports,
          'constructStack',
          (orig: any) => {
            self._diag.debug('propwrapping aws-sdk v3 constructStack');
            return self._getV3ConstructStackPatch(moduleVersion, orig);
          }
        );
        return newExports;
      }
    );

    const v3SmithyClient = new InstrumentationNodeModuleDefinition(
      '@aws-sdk/smithy-client',
      ['^3.1.0'],
      this.patchV3SmithyClient.bind(this),
      this.unpatchV3SmithyClient.bind(this)
    );

    // patch for new @smithy/smithy-client for aws-sdk packages v3.363.0+
    const v3NewSmithyClient = new InstrumentationNodeModuleDefinition(
      '@smithy/smithy-client',
      ['>=1.0.3'],
      this.patchV3SmithyClient.bind(this),
      this.unpatchV3SmithyClient.bind(this)
    );

    return [
      v3MiddlewareStack,
      v3SmithyMiddlewareStack,
      v3SmithyClient,
      v3NewSmithyClient,
    ];
  }

  protected patchV3ConstructStack(moduleExports: any, moduleVersion?: string) {
    this._wrap(
      moduleExports,
      'constructStack',
      this._getV3ConstructStackPatch.bind(this, moduleVersion)
    );
    return moduleExports;
  }

  protected unpatchV3ConstructStack(moduleExports: any) {
    this._unwrap(moduleExports, 'constructStack');
    return moduleExports;
  }

  protected patchV3SmithyClient(moduleExports: any) {
    this._wrap(
      moduleExports.Client.prototype,
      'send',
      this._getV3SmithyClientSendPatch.bind(this)
    );
    return moduleExports;
  }

  protected unpatchV3SmithyClient(moduleExports: any) {
    this._unwrap(moduleExports.Client.prototype, 'send');
    return moduleExports;
  }

  private _startAwsV3Span(
    normalizedRequest: NormalizedRequest,
    metadata: RequestMetadata
  ): Span {
    const name =
      metadata.spanName ??
      `${normalizedRequest.serviceName}.${normalizedRequest.commandName}`;
    const newSpan = this.tracer.startSpan(name, {
      kind: metadata.spanKind ?? SpanKind.CLIENT,
      attributes: {
        ...extractAttributesFromNormalizedRequest(normalizedRequest),
        ...metadata.spanAttributes,
      },
    });

    return newSpan;
  }

  private _callUserPreRequestHook(
    span: Span,
    request: NormalizedRequest,
    moduleVersion: string | undefined
  ) {
    const { preRequestHook } = this.getConfig();
    if (preRequestHook) {
      const requestInfo: AwsSdkRequestHookInformation = {
        moduleVersion,
        request,
      };
      safeExecuteInTheMiddle(
        () => preRequestHook(span, requestInfo),
        (e: Error | undefined) => {
          if (e)
            diag.error(
              `${AwsInstrumentation.component} instrumentation: preRequestHook error`,
              e
            );
        },
        true
      );
    }
  }

  private _callUserResponseHook(span: Span, response: NormalizedResponse) {
    const { responseHook } = this.getConfig();
    if (!responseHook) return;

    const responseInfo: AwsSdkResponseHookInformation = {
      response,
    };
    safeExecuteInTheMiddle(
      () => responseHook(span, responseInfo),
      (e: Error | undefined) => {
        if (e)
          diag.error(
            `${AwsInstrumentation.component} instrumentation: responseHook error`,
            e
          );
      },
      true
    );
  }

  private _getV3ConstructStackPatch(
    moduleVersion: string | undefined,
    original: (...args: unknown[]) => MiddlewareStack<any, any>
  ) {
    const self = this;
    return function constructStack(
      this: any,
      ...args: unknown[]
    ): MiddlewareStack<any, any> {
      const stack: MiddlewareStack<any, any> = original.apply(this, args);
      self.patchV3MiddlewareStack(moduleVersion, stack);
      return stack;
    };
  }

  private _getV3SmithyClientSendPatch(
    original: (...args: unknown[]) => Promise<any>
  ) {
    return function send(
      this: any,
      command: V3PluginCommand,
      ...args: unknown[]
    ): Promise<any> {
      command[V3_CLIENT_CONFIG_KEY] = this.config;
      return original.apply(this, [command, ...args]);
    };
  }

  private patchV3MiddlewareStack(
    moduleVersion: string | undefined,
    middlewareStackToPatch: MiddlewareStack<any, any>
  ) {
    if (!isWrapped(middlewareStackToPatch.resolve)) {
      this._wrap(
        middlewareStackToPatch,
        'resolve',
        this._getV3MiddlewareStackResolvePatch.bind(this, moduleVersion)
      );
    }

    // 'clone' and 'concat' functions are internally calling 'constructStack' which is in same
    // module, thus not patched, and we need to take care of it specifically.
    this._wrap(
      middlewareStackToPatch,
      'clone',
      this._getV3MiddlewareStackClonePatch.bind(this, moduleVersion)
    );
    this._wrap(
      middlewareStackToPatch,
      'concat',
      this._getV3MiddlewareStackClonePatch.bind(this, moduleVersion)
    );
  }

  private _getV3MiddlewareStackClonePatch(
    moduleVersion: string | undefined,
    original: (...args: any[]) => MiddlewareStack<any, any>
  ) {
    const self = this;
    return function (this: any, ...args: any[]) {
      const newStack = original.apply(this, args);
      self.patchV3MiddlewareStack(moduleVersion, newStack);
      return newStack;
    };
  }

  private _getV3MiddlewareStackResolvePatch(
    moduleVersion: string | undefined,
    original: (
      _handler: any,
      context: HandlerExecutionContext
    ) => AwsV3MiddlewareHandler<any, any>
  ) {
    const self = this;
    return function (
      this: any,
      _handler: any,
      awsExecutionContext: HandlerExecutionContext
    ): AwsV3MiddlewareHandler<any, any> {
      const origHandler = original.call(this, _handler, awsExecutionContext);
      const patchedHandler = function (
        this: any,
        command: InitializeHandlerArguments<any> & {
          [V3_CLIENT_CONFIG_KEY]?: any;
        }
      ): Promise<any> {
        const clientConfig = command[V3_CLIENT_CONFIG_KEY];
        const regionPromise = clientConfig?.region?.();
        const serviceName =
          clientConfig?.serviceId ??
          removeSuffixFromStringIfExists(
            // Use 'AWS' as a fallback serviceName to match type definition.
            // In practice, `clientName` should always be set.
            awsExecutionContext.clientName || 'AWS',
            'Client'
          );
        const commandName =
          awsExecutionContext.commandName ?? command.constructor?.name;
        const normalizedRequest = normalizeV3Request(
          serviceName,
          commandName,
          command.input,
          undefined
        );
        const requestMetadata = self.servicesExtensions.requestPreSpanHook(
          normalizedRequest,
          self.getConfig(),
          self._diag
        );
        const startTime = hrTime();
        const span = self._startAwsV3Span(normalizedRequest, requestMetadata);
        const activeContextWithSpan = trace.setSpan(context.active(), span);

        const handlerPromise = new Promise((resolve, reject) => {
          Promise.resolve(regionPromise)
            .then(resolvedRegion => {
              normalizedRequest.region = resolvedRegion;
              span.setAttribute(AttributeNames.AWS_REGION, resolvedRegion);
            })
            .catch(e => {
              // there is nothing much we can do in this case.
              // we'll just continue without region
              diag.debug(
                `${AwsInstrumentation.component} instrumentation: failed to extract region from async function`,
                e
              );
            })
            .finally(() => {
              self._callUserPreRequestHook(
                span,
                normalizedRequest,
                moduleVersion
              );
              const resultPromise = context.with(activeContextWithSpan, () => {
                self.servicesExtensions.requestPostSpanHook(normalizedRequest);
                return self._callOriginalFunction(() =>
                  origHandler.call(this, command)
                );
              });
              const promiseWithResponseLogic = resultPromise
                .then(response => {
                  const requestId = response.output?.$metadata?.requestId;
                  if (requestId) {
                    span.setAttribute(AttributeNames.AWS_REQUEST_ID, requestId);
                  }

                  const httpStatusCode =
                    response.output?.$metadata?.httpStatusCode;
                  if (httpStatusCode) {
                    span.setAttribute(
                      SEMATTRS_HTTP_STATUS_CODE,
                      httpStatusCode
                    );
                  }

                  const extendedRequestId =
                    response.output?.$metadata?.extendedRequestId;
                  if (extendedRequestId) {
                    span.setAttribute(
                      AttributeNames.AWS_REQUEST_EXTENDED_ID,
                      extendedRequestId
                    );
                  }

                  const normalizedResponse: NormalizedResponse = {
                    data: response.output,
                    request: normalizedRequest,
                    requestId: requestId,
                  };
                  const override = self.servicesExtensions.responseHook(
                    normalizedResponse,
                    span,
                    self.tracer,
                    self.getConfig(),
                    startTime
                  );
                  if (override) {
                    response.output = override;
                    normalizedResponse.data = override;
                  }
                  self._callUserResponseHook(span, normalizedResponse);
                  return response;
                })
                .catch(err => {
                  const requestId = err?.RequestId;
                  if (requestId) {
                    span.setAttribute(AttributeNames.AWS_REQUEST_ID, requestId);
                  }

                  const httpStatusCode = err?.$metadata?.httpStatusCode;
                  if (httpStatusCode) {
                    span.setAttribute(
                      SEMATTRS_HTTP_STATUS_CODE,
                      httpStatusCode
                    );
                  }

                  const extendedRequestId = err?.extendedRequestId;
                  if (extendedRequestId) {
                    span.setAttribute(
                      AttributeNames.AWS_REQUEST_EXTENDED_ID,
                      extendedRequestId
                    );
                  }

                  span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: err.message,
                  });
                  span.recordException(err);
                  throw err;
                })
                .finally(() => {
                  if (!requestMetadata.isStream) {
                    span.end();
                  }
                });
              promiseWithResponseLogic
                .then(res => {
                  resolve(res);
                })
                .catch(err => reject(err));
            });
        });

        return requestMetadata.isIncoming
          ? bindPromise(handlerPromise, activeContextWithSpan, 2)
          : handlerPromise;
      };
      return patchedHandler;
    };
  }

  private _callOriginalFunction<T>(originalFunction: (...args: any[]) => T): T {
    if (this.getConfig().suppressInternalInstrumentation) {
      return context.with(suppressTracing(context.active()), originalFunction);
    } else {
      return originalFunction();
    }
  }

  override _updateMetricInstruments() {
    if (!this.servicesExtensions) {
      this.servicesExtensions = new ServicesExtensions();
    }
    this.servicesExtensions.updateMetricInstruments(this.meter);
  }
}
