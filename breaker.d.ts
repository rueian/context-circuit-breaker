declare namespace ContextCircuitBreaker { }

interface IContextCircuitBreakerOptions {
  windowDuration?: number,
  timeoutDuration?: number,
  errorThreshold?: number,
  volumeThreshold?: number,

  contextBuilder?: IContextCircuitBreakerContextBuilder;
  contextCleaner?: IContextCircuitBreakerContextCleaner;
  nextTryTimeout?: IContextCircuitBreakerNextTryTimeout;
}

interface IContextCircuitBreakerContextBuilder {
  (): Promise<any>
}

interface IContextCircuitBreakerContextCleaner {
  (context: any): Promise<any>
}

interface IContextCircuitBreakerNextTryTimeout {
  (): number
}

interface IContextCircuitBreakerCommandCallback {
  (context: any): Promise<any>
}

interface IContextCircuitBreakerFallbackCallback {
  (err: Error): Promise<any>
}

declare class ContextCircuitBreaker {
  constructor(opts: IContextCircuitBreakerOptions);

  public run(command: IContextCircuitBreakerCommandCallback, fallback: IContextCircuitBreakerFallbackCallback | any): Promise<any>;

  public destroy(): void;
}

export = ContextCircuitBreaker