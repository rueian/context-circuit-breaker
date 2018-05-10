'use strict';

const assert = require('assert');
const EventEmitter = require('events').EventEmitter;

const OPEN = 'OPEN';
const HALF_OPEN = 'HALF_OPEN';
const HALF_OPEN_VERIFY = 'HALF_OPEN_VERIFY';
const CLOSE = 'CLOSE';

class ContextCircuitBreaker extends EventEmitter {
  constructor(opts = {}) {
    super();
    
    this.windowDuration  = opts.windowDuration  || 10000; // milliseconds
    this.timeoutDuration = opts.timeoutDuration || 300;  // milliseconds
    this.errorThreshold  = opts.errorThreshold  || 50;   // percentage
    this.volumeThreshold = opts.volumeThreshold || 5;    // number

    this.contextBuilder = opts.contextBuilder || function() {};
    this.contextCleaner = opts.contextCleaner || function() {};
    this.nextTryTimeout = opts.nextTryTimeout || function() { return 5000; };

    this.state = OPEN;
    this.context = null;
    this.resetTimer = null;
    this.nextTryTimer = null;
    this.counters = this._newCounters();

    this._tryTransitToHalfOpen();
    this._scheduleTryTransitToHalfOpen();
    this._startResetTicker();
  }

  run(command, fallback) {
    if (this.state === CLOSE) {
      return this._execCommand(command).catch((err) => {
        this._updateState();
        return this._execFallback(fallback, err);
      });
    }

    if (this.state === OPEN || this.state === HALF_OPEN_VERIFY) {
      this.counters.shortCircuits++;
      return this._execFallback(fallback, new ContextCircuitBreakerOpenError());
    }

    if (this.state === HALF_OPEN) {
      this.state = HALF_OPEN_VERIFY;
      return this._execCommand(command).then((res) => {
        this._transitToClose();
        return res;
      }).catch((err) => {
        this._transitToOpen();
        return this._execFallback(fallback, err);
      });
    }
  }

  destroy() {
    clearInterval(this.resetTimer);
    clearTimeout(this.nextTryTimer);
    this._cleanContext();
    this.removeAllListeners();
    this.status = null;
  }

  _execCommand(command) {
    return new Promise((resolve, reject) => {
      let timmer;
      const checkTimmer = (prop, callback) => (ret) => {
        if (!timmer) return;
        clearTimeout(timmer);
        timmer = null;
        this.counters[prop]++;
        callback(ret);
      };

      timmer = setTimeout(checkTimmer('timeouts', reject), this.timeoutDuration, new ContextCircuitBreakerTimeoutError());
      try {
        Promise.resolve(command(this.context))
          .then(checkTimmer('successes', resolve))
          .catch(checkTimmer('failures', reject));
      } catch(err) {
        Promise.reject(err).catch(checkTimmer('failures', reject))
      }
    });
  }

  _execFallback(fallback, err) {
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

  _startResetTicker() {
    this.resetTimer = setInterval(() => {
      this._updateState();
      this.counters = this._newCounters();
    }, this.windowDuration);
  }

  _cleanContext() {
    Promise.resolve(this.contextCleaner(this.context)).then((ctx) => {
      this.emit('contextCleanerSucceeded', ctx);
    }).catch((err) => {
      this.emit('contextCleanerFailed', err);
    });
    this.context = null;
  }

  _tryTransitToHalfOpen() {
    if (this._trying || this.state !== OPEN) return;

    this._trying = true;
    Promise.resolve(this.contextBuilder()).then((ctx) => {
      this._trying = false;
      this.context = ctx;
      this.state = HALF_OPEN;
      this.emit('contextBuilderSucceeded', ctx);
      this.emit('stateChanged', this.state);
    }).catch((err) => {
      this._trying = false;
      this.emit('contextBuilderFailed', err);
    });
  }

  _scheduleTryTransitToHalfOpen() {
    if (this.nextTryTimer || this.state !== OPEN) return;

    this.nextTryTimer = setTimeout(() => {
      this.nextTryTimer = null;
      this._tryTransitToHalfOpen();
      this._scheduleTryTransitToHalfOpen();
    }, this.nextTryTimeout());
  }

  _transitToOpen() {
    this._cleanContext();
    this.state = OPEN;
    this._scheduleTryTransitToHalfOpen();
    this.emit('stateChanged', this.state);
  }

  _transitToClose() {
    this.state = CLOSE;
    this.emit('stateChanged', this.state);
  }

  _newCounters() {
    return { timeouts: 0, failures: 0, successes: 0, shortCircuits: 0 };
  }

  _updateState() {
    if (this.state !== CLOSE) return;

    const metrics = this._calculateMetrics();
    const overErrorThreshold = metrics.errorPercentage > this.errorThreshold;
    const overVolumeThreshold = metrics.totalCount > this.volumeThreshold;
    const overThreshold = overVolumeThreshold && overErrorThreshold;
    if (overThreshold) {
      this._transitToOpen();
    }
  }

  _calculateMetrics() {
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
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}
class ContextCircuitBreakerOpenError extends ContextCircuitBreakerError {}
class ContextCircuitBreakerTimeoutError extends ContextCircuitBreakerError {}

module.exports = ContextCircuitBreaker;
