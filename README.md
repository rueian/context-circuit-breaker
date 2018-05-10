# ContextCircuitBreaker

Modified from https://github.com/yammer/circuit-breaker-js

## Usage

```js
const MongoClient = require('mongodb').MongoClient;
const breaker = new ContextCircuitBreaker({
  contextBuilder: async () => await MongoClient.connect('mongodb://localhost:27017', { reconnectTries: 1 }),
  contextCleaner: async (client) => client.close()
});

const command = async (client) => {
  return await client.db('mydb').collection('mycollection').find({a: 1}).limit(2).toArray();
};

const fallback = async () => {
  return [];
}

breaker.run(command, fallback).then((ret) => {
  console.log(ret); // []
})

breaker.destroy();
```

## API


### ContextCircuitBreaker([config])

Create a new instance of a circuit breaker. Accepts the following config options:

#### contextBuilder() -> Promise

A function build the context and return Promise.resolve(context) or Promise.reject(err).

ContextCircuitBreaker will call this function when trying to transit HALF_OPEN state and keep the context for running command

#### contextCleaner(context) -> Promise

A function clean the context and return Promise.resolve() or Promise.reject(err).

ContextCircuitBreaker will call this function when transit to OPEN state.

### nextTryTimeout() -> integer

A function return a integer as milliseconds.

ContextCircuitBreaker will call this function when failing to transit HALF_OPEN state to schedule the next try.

*Default Value:* function() { return 5000 }

#### windowDuration

Duration of statistical rolling window in milliseconds. This is how long metrics are kept for the circuit breaker to use and for publishing.

*Default Value:* 10000

#### timeoutDuration

Time in milliseconds after which a command will timeout.

*Default Value:* 300

#### errorThreshold

Error percentage at which the circuit should trip open and start short-circuiting requests to fallback logic.

*Default Value:* 50

#### volumeThreshold

Minimum number of requests in rolling window needed before tripping the circuit will occur.

For example, if the value is 20, then if only 19 requests are received in the rolling window (say 10 seconds) the circuit will not trip open even if all 19 failed.

*Default Value:* 5

### run(command, fallback)

the `command` should be: `function(context) -> Promise`

the `fallback` should be: `function(err) -> Promise`

this behavior is:

```
#run when state is CLOSE
  ✓ execute command(context)
  ✓ return Promise.resolve(command(context)) if command(context) succeeded
  ✓ return Promise.resolve(fallback(commandErr)) if command(context) returned Promise.reject(commandErr)
  ✓ return Promise.resolve(fallback(commandErr)) if command(context) throwed commandErr
  ✓ return Promise.resolve(fallback(timeoutErr)) if command(context) timeout
  ✓ return Promise.reject(commandErr) if no fallback provided and command(context) returned Promise.reject(commandErr)
  ✓ return Promise.reject(commandErr) if no fallback provided and command(context) throwed commandErr
  ✓ return Promise.reject(timeoutErr) if no fallback provided and command(context) timeout
  ✓ transit to OPEN if the failures of command(context) exceed the volumeThreshold and errorThreshold

#run when state is OPEN
  ✓ return Promise.resolve(fallback(openErr))
  ✓ return Promise.reject(openErr) if no fallback provided
```

### destroy()

Cleanup context by calling contextCleaner(context) and clear all timers and all event listeners.

## State Machine Spec

```
given OPEN state
  when receives command
    then return fallback
  when nextTry timeout reached
    then try to run contextBuilder
      given service is not connectable  
        then emit contextbuilderFailed
        then remain state OPEN
        then schedule nextTry timeout
      given service connectable
        then transit to HALF_OPEN
        then emit stateChanged with HALF_OPEN
        then emit contextbuilderSucceeded

given HALF_OPEN state
  when receives the first command
    then run command
      given the first command succeeded
        then return command result
        then transit to CLOSE
        then emit stateChanged with CLOSE
      given the first command failed
        then return fallback
        then transit to OPEN
        then emit stateChanged with OPEN
        then schedule nextTry timeout 
        then run contextBuilderCleaner
          given contextBuilderCleaner succeed
            then emit contextBuilderCleanerSucceeded
          given contextBuilderCleaner failed
            then emit contextBuilderCleanerFailed
  when receives following commands
    then all return fallback

given CLOSE state
  when receives command
    then run command
      given command succeed
        then return command result
      given command failed
        then return fallback
          given volumeThreshold not exceed
            then remain CLOSE
          given volumeThreshold exceed
            given errorThreshold not exceed
              then remain CLOSE
            given errorThreshold exceeded
              then transit to OPEN
              then emit stateChanged with OPEN
              then schedule nextTry timeout 
              then run contextBuilderCleaner
                given contextBuilderCleaner succeed
                  then emit contextBuilderCleanerSucceeded
                given contextBuilderCleaner failed
                  then emit contextBuilderCleanerFailed
```