'use strict';

const assert = require('assert');
const ContextCircuitBreaker = require('./breaker');

function newContextCircuitBreaker(builder) {
  return new ContextCircuitBreaker({
    contextBuilder: () => builder
  })
}

describe('ContextCircuitBreaker', function() {

  it('initial state is OPEN', function() {
    let breaker = new ContextCircuitBreaker();
    assert.equal(breaker.state, 'OPEN');
    breaker.destroy();
  });

  describe('when state is OPEN', function() {
    it('fallback all commands', function(done) {
      let breaker = newContextCircuitBreaker(Promise.reject());

      breaker.run(() => 1, () => 2).then((ret) => {
        breaker.destroy();
        assert.equal(ret, 2);
        done();
      });
    });

    it('try to transit to HALF_OPEN and succeed', function(done) {
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
    it('try first command and succeed to CLOSE state', function(done) {
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
        } else if (state === 'OPEN'){
          breaker.destroy();
          done();
        }
      });
    });
  });
});