'use strict';

import {  EventEmitter } from 'events';

const _noopPromise = (a: any) => Promise.resolve();

enum State {
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
  HALF_OPEN_VERIFY = 'HALF_OPEN_VERIFY',
  CLOSE = 'CLOSE'
}

interface IPromiseMiddleware<A, R> {
  (ctx?: A): Promise<R> 
}

interface IInitOpts {
  windowDuration?: number;
  timeoutDuration?: number;
  errorThreshold?: number;
  volumeThreshold?: number;
  contextBuilder?: IPromiseMiddleware<any, any>;
  contextCleaner?: IPromiseMiddleware<any, any>;
  nextTryTimeout?: () => number;
}

interface ICounter {
  timeouts: number;
  failures: number;
  successes: number;
  shortCircuits: number;
}

interface IMertrics {
  totalCount: number;
  errorCount: number;
  errorPercentage: number;
}

class ContextCircuitBreaker extends EventEmitter {
  private windowDuration: number = 1000; // milliseconds
  private timeoutDuration: number = 300; // milliseconds
  private errorThreshold: number = 50; // percentage
  private volumeThreshold: number = 5; // number
  private contextBuilder: IPromiseMiddleware<any, any> = _noopPromise;
  private contextCleaner: IPromiseMiddleware<any, any>= _noopPromise;
  private nextTryTimeout = () => 5000;
  private state: State = State.OPEN;
  private resetTimer: NodeJS.Timeout = null;
  private nextTryTimer: NodeJS.Timeout = null;
  private counters: ICounter;
  private context: any = null;
  private _trying: boolean = false;

  constructor(opts: IInitOpts = {}) {
    super();

    [
      'windowDuration',
      'timeoutDuration',
      'errorThreshold',
      'volumeThreshold',
      'contextBuilder',
      'contextCleaner',
      'nextTryTimeout'

    ].forEach((key) => {
      if(opts[key] && opts[key] !== undefined) {
        this[key] = opts[key];
      }
    });

    this.counters = this._newCounters();
    this._tryTransitToHalfOpen();
    this._scheduleTryTransitToHalfOpen();
    this._startResetTicker();
  }
  public run<R, DR>(command: IPromiseMiddleware<any, R>, fallback: DR | IPromiseMiddleware<Error, any>) {

    if (this.state === State.CLOSE) {
      return this._execCommand(command).catch((err) => {
        this._updateState();
        return this._execFallback<DR>(fallback, err);
      });
    }

    if (this.state === State.OPEN || this.state === State.HALF_OPEN_VERIFY) {
      this.counters.shortCircuits++;
      return this._execFallback<DR>(fallback, new ContextCircuitBreakerOpenError());
    }

    if (this.state === State.HALF_OPEN) {
      this.state = State.HALF_OPEN_VERIFY;
      return this._execCommand(command).then((res) => {
        this._transitToClose();
        return res;
      }).catch((err) => {
        this._transitToOpen();
        return this._execFallback<DR>(fallback, err);
      });
    }
  }

  public destroy() {
    clearInterval(this.resetTimer);
    clearTimeout(this.nextTryTimer);
    this._cleanContext();
    this.removeAllListeners();
    this.state = null;
  }

  private _execCommand<R>(command: IPromiseMiddleware<any, R>): Promise<any> {
    return new Promise((resolve, reject) => {
      let timmer: NodeJS.Timeout;

      const checkTimmer = (prop: string, callback: (val: any) => void) => (ret) => {
        if (!timmer) return;
        clearTimeout(timmer);
        timmer = null;
        this.counters[prop]++;
        callback(ret);
      };

      timmer = setTimeout(
        checkTimmer('timeouts', reject),
        this.timeoutDuration,
        new ContextCircuitBreakerTimeoutError()
      );

      try {
        Promise.resolve(command(this.context))
          .then(checkTimmer('successes', resolve))
          .catch(checkTimmer('failures', reject));
      } catch(err) {
        Promise.reject(err).catch(checkTimmer('failures', reject))
      }
    });
  }

  private _execFallback<DR>(fallback: DR | IPromiseMiddleware<Error, any>, err: Error) {
    this.emit('fallback', err);
    if (fallback instanceof Function) {
      try {
        return Promise.resolve(fallback(err));
      } catch (err) {
        return Promise.reject(err);
      }
    } else if (fallback !== undefined) {
      return Promise.resolve(fallback);
    }
    return Promise.reject(err);
  }

  private _startResetTicker() {
    this.resetTimer = setInterval(() => {
      this._updateState();
      this.counters = this._newCounters();
    }, this.windowDuration);
  }

  private _cleanContext() {
    Promise.resolve(this.contextCleaner(this.context)).then((ctx) => {
      this.emit('contextCleanerSucceeded', ctx);
    }).catch((err) => {
      this.emit('contextCleanerFailed', err);
    });
    this.context = null;
  }

  private _tryTransitToHalfOpen() {
    if (this._trying || this.state !== State.OPEN) return;

    this._trying = true;

    Promise.resolve(this.contextBuilder()).then((ctx) => {
      this._trying = false;
      this.context = ctx;
      this.state = State.HALF_OPEN;
      this.emit('contextBuilderSucceeded', ctx);
      this.emit('stateChanged', this.state);
    }).catch((err) => {
      this._trying = false;
      this.emit('contextBuilderFailed', err);
    });
  }

  private _scheduleTryTransitToHalfOpen() {
    if (this.nextTryTimer || this.state !== State.OPEN) return;

    this.nextTryTimer = setTimeout(() => {
      this.nextTryTimer = null;
      this._tryTransitToHalfOpen();
      this._scheduleTryTransitToHalfOpen();
    }, this.nextTryTimeout());
  }

  private _transitToOpen() {
    this._cleanContext();
    this.state = State.OPEN;
    this._scheduleTryTransitToHalfOpen();
    this.emit('stateChanged', this.state);
  }

  private _transitToClose() {
    this.state = State.CLOSE;
    this.emit('stateChanged', this.state);
  }

  private _newCounters(): ICounter {
    return { timeouts: 0, failures: 0, successes: 0, shortCircuits: 0 };
  }

  private _updateState() {
    if (this.state !== State.CLOSE) return;

    const metrics = this._calculateMetrics();
    const overErrorThreshold = metrics.errorPercentage > this.errorThreshold;
    const overVolumeThreshold = metrics.totalCount > this.volumeThreshold;
    const overThreshold = overVolumeThreshold && overErrorThreshold;
    if (overThreshold) {
      this._transitToOpen();
    }
  }

  private _calculateMetrics(): IMertrics {
    const errorCount = this.counters.timeouts + this.counters.failures;
    const totalCount = errorCount + this.counters.successes;
    const errorPercentage = (errorCount / (totalCount > 0 ? totalCount : 1)) * 100;

    return {
      totalCount: totalCount,
      errorCount: errorCount,
      errorPercentage: errorPercentage
    };
  }
}

class ContextCircuitBreakerError extends Error {
  constructor(message = '') {
    super(message);
    this.name = this.constructor.name;
  }
}
class ContextCircuitBreakerOpenError extends ContextCircuitBreakerError {}
class ContextCircuitBreakerTimeoutError extends ContextCircuitBreakerError {}

module.exports = ContextCircuitBreaker;
