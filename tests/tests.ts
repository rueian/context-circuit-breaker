'use strict';

const assert = require('assert');
const ContextCircuitBreaker = require('./breaker');

function newContextCircuitBreaker(builder) {
  return new ContextCircuitBreaker({
    contextBuilder: () => builder
  })
}

describe('ContextCircuitBreaker', function() {

  describe('State Machine', function () {
    it('initial state is OPEN', function () {
      let breaker = new ContextCircuitBreaker();
      assert.equal(breaker.state, 'OPEN');
      breaker.destroy();
    });

    describe('when state is OPEN', function () {
      it('fallback all commands', function (done) {
        let breaker = newContextCircuitBreaker(Promise.reject());

        breaker.run(() => 1, () => 2).then((ret) => {
          breaker.destroy();
          assert.equal(ret, 2);
          done();
        });
      });

      it('try to transit to HALF_OPEN and succeed', function (done) {
        let breaker = newContextCircuitBreaker(Promise.resolve(1));

        breaker.once('contextBuilderSucceeded', (ret) => {
          breaker.destroy();
          assert.equal(ret, 1);
          assert.equal(breaker.state, 'HALF_OPEN');
          done();
        });

        breaker.once('contextBuilderFailed', (err) => {
          breaker.destroy();
          done(err);
        });
      });

      it('try to transit to HALF_OPEN and failed', function (done) {
        let breaker = newContextCircuitBreaker(Promise.reject(1));

        breaker.once('contextBuilderSucceeded', (ret) => {
          breaker.destroy();
          done(ret);
        });

        breaker.once('contextBuilderFailed', (err) => {
          breaker.destroy();
          assert.equal(err, 1);
          assert.equal(breaker.state, 'OPEN');
          done();
        });
      });
    });

    describe('when state is HALF_OPEN', function () {
      it('try first command and succeed to CLOSE state', function (done) {
        let breaker = newContextCircuitBreaker(Promise.resolve(1));

        breaker.on('stateChanged', (state) => {
          if (state === 'HALF_OPEN') {
            breaker.run(() => 1, () => 2);
          } else if (state === 'CLOSE') {
            breaker.destroy();
            done();
          } else {
            breaker.destroy();
            done(`TEST FAIL: transit to wrong state ${state}`);
          }
        });
      });

      it('try first command and failed to OPEN state', function (done) {
        let breaker = newContextCircuitBreaker(Promise.resolve(1));

        breaker.on('stateChanged', (state) => {
          if (state === 'HALF_OPEN') {
            breaker.run(() => Promise.reject(), () => 2);
          } else if (state === 'OPEN') {
            clearInterval(breaker.nextTryTimer);
            breaker.destroy();
            done();
          } else {
            breaker.destroy();
            done(`TEST FAIL: transit to wrong state ${state}`);
          }
        });
      });

      it('fallback other commands', function (done) {
        let breaker = newContextCircuitBreaker(Promise.resolve(1));

        breaker.on('stateChanged', (state) => {
          if (state === 'HALF_OPEN') {
            breaker.run(() => 1, () => 2);
            breaker.run(() => 3, () => 4).then((ret) => {
              assert.equal(ret, 4);
              breaker.destroy();
              done();
            });
          } else {
            breaker.destroy();
            done(`TEST FAIL: transit to wrong state ${state}`);
          }
        });
      });
    });

    describe('when state is CLOSE', function () {
      it('run all commands', function (done) {
        let breaker = newContextCircuitBreaker(Promise.resolve(1));

        breaker.on('stateChanged', (state) => {
          if (state === 'HALF_OPEN') {
            breaker.run(() => 1, () => 2);
          } else if (state === 'CLOSE') {
            breaker.run(() => 3, () => 4).then((ret) => {
              assert.equal(ret, 3);
              breaker.destroy();
              done();
            });
          } else {
            breaker.destroy();
            done(`TEST FAIL: transit to wrong state ${state}`);
          }
        });
      });

      it('exceed error threshold and transit to OPEN state', function (done) {
        let breaker = newContextCircuitBreaker(Promise.resolve(1));

        breaker.on('stateChanged', (state) => {
          if (state === 'HALF_OPEN') {
            breaker.run(() => 1, () => 2);
          } else if (state === 'CLOSE') {
            for (let i = 0; i < 10; i++) {
              breaker.run(() => Promise.reject(), () => 4);
            }
          } else if (state === 'OPEN') {
            breaker.destroy();
            done();
          }
        });
      });
    });
  });

  describe('#run when state is CLOSE', () => {
    const CONTEXT = 'anything';
    let breaker;
    let counters;

    beforeEach(() => {
      breaker = new ContextCircuitBreaker({
        contextBuilder: () => CONTEXT,
        timeoutDuration: 10,
        errorThreshold: 50,
        volumeThreshold: 2
      });
      return new Promise((resolve) => {
        breaker.on('stateChanged', (state) => {
          if (state === 'HALF_OPEN') breaker.run(() => 1);
          if (state === 'CLOSE') {
            counters = Object.assign({}, breaker.counters);
            resolve();
          };
        })
      });
    });

    afterEach(() => {
      breaker.destroy();
    });

    it ('execute command(context)', (done) => {
      breaker.run((ctx) => {
        assert.equal(ctx, CONTEXT);
        done();
      });
    });

    it('return Promise.resolve(command(context)) if command(context) succeeded', (done) => {
      breaker.run(() => 1).then((ret) => {
        assert.equal(ret, 1);
        counters.successes++;
        assert.deepEqual(counters, breaker.counters);
        done();
      });
    });

    it('return Promise.resolve(fallback(commandErr)) if command(context) returned Promise.reject(commandErr)', (done) => {
      breaker.run(() => Promise.reject('failed'), (err) => {
        assert.equal(err, 'failed');
        return 2;
      }).then((ret) => {
        assert.equal(ret, 2);
        counters.failures++;
        assert.deepEqual(counters, breaker.counters);
        done();
      });
    });

    it('return Promise.resolve(fallback(commandErr)) if command(context) throwed commandErr', (done) => {
      breaker.run(() => {
        throw 'failed'
      }, (err) => {
        assert.equal(err, 'failed');
        return 2;
      }).then((ret) => {
        assert.equal(ret, 2);
        counters.failures++;
        assert.deepEqual(counters, breaker.counters);
        done();
      });
    });

    it('return Promise.resolve(fallback(timeoutErr)) if command(context) timeout', (done) => {
      breaker.run(() => {
        return new Promise(resolve => setTimeout(resolve, 20));
      }, (err) => {
        assert.equal(err.name, 'ContextCircuitBreakerTimeoutError');
        return 2;
      }).then((ret) => {
        assert.equal(ret, 2);
        counters.timeouts++;
        assert.deepEqual(counters, breaker.counters);
        done();
      });
    });

    it('return Promise.reject(commandErr) if no fallback provided and command(context) returned Promise.reject(commandErr)', (done) => {
      breaker.run(() => Promise.reject('failed')).catch((err) => {
        assert.equal(err, 'failed');
        counters.failures++;
        assert.deepEqual(counters, breaker.counters);
        done();
      });
    });

    it('return Promise.reject(commandErr) if no fallback provided and command(context) throwed commandErr', (done) => {
      breaker.run(() => {
        throw 'failed';
      }).catch((err) => {
        assert.equal(err, 'failed');
        counters.failures++;
        assert.deepEqual(counters, breaker.counters);
        done();
      });
    });

    it('return Promise.reject(timeoutErr) if no fallback provided and command(context) timeout', (done) => {
      breaker.run(() => {
        return new Promise(resolve => setTimeout(resolve, 20));
      }).catch((err) => {
        assert.equal(err.name, 'ContextCircuitBreakerTimeoutError');
        counters.timeouts++;
        assert.deepEqual(counters, breaker.counters);
        done();
      });
    });

    it('transit to OPEN if the failures of command(context) exceed the volumeThreshold and errorThreshold', (done) => {
      breaker.once('stateChanged', (state) => {
        if (state === 'OPEN') done();
      })
      for (let i = 0; i < breaker.volumeThreshold + 1; i++) {
        breaker.run(() => Promise.reject(), 0);
      }
    });
  })

  describe('#run when state is OPEN', () => {
    let breaker;

    beforeEach(() => {
      breaker = newContextCircuitBreaker(Promise.reject());
    });

    afterEach(() => {
      breaker.destroy();
    });

    it('return Promise.resolve(fallback(openErr))', (done) => {
      breaker.run(() => 1, (err) => {
        assert.equal(err.name, 'ContextCircuitBreakerOpenError');
        return 2;
      }).then((ret) => {
        assert.equal(ret, 2);
        done();
      });
    });

    it('return Promise.reject(openErr) if no fallback provided', (done) => {
      breaker.run(() => {
        throw 'failed';
      }).catch((err) => {
        assert.equal(err, 'ContextCircuitBreakerOpenError');
        done();
      });
    });
  })
});