//
// Copyright (c) 2020 by SAP SE or an SAP affiliate company. All rights reserved. This file is licensed under the Apache Software License, v. 2 except as noted otherwise in the LICENSE file
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

'use strict'

const EventEmitter = require('events')
const pEvent = require('p-event')
const moment = require('moment')

const ApiErrors = require('../lib/kubernetes-client/ApiErrors')
const { Reflector, Store, ListPager } = require('../lib/kubernetes-client/cache')
const nextTick = () => new Promise(resolve => process.nextTick(resolve))

describe('kubernetes-client', function () {
  /* eslint no-unused-expressions: 0 */

  const sandbox = sinon.createSandbox()

  afterEach(function () {
    sandbox.restore()
  })

  describe('cache', function () {
    let map
    let store
    let listWatcher
    let destroyAgentSpy

    function createDummy (metadata) {
      return {
        apiVersion: 'v1',
        kind: 'Dummy',
        metadata: { ...metadata }
      }
    }

    const a = createDummy({ uid: 'a', resourceVersion: '1' })
    const b = createDummy({ uid: 'b', resourceVersion: '2' })
    const c = createDummy({ uid: 'c', resourceVersion: '3' })
    const x = createDummy({ uid: 'a', resourceVersion: '4' })
    const bookmark = createDummy({ resourceVersion: '9' })

    class TestSocket extends EventEmitter {
      constructor ({ maxPingPongCount = Infinity } = {}) {
        super()
        this.readyState = 0
        this.pingPongCount = 0
        this.maxPingPongCount = maxPingPongCount
        process.nextTick(() => {
          this.readyState = 1
          this.emit('open')
        })
      }

      ping () {
        if (this.pingPongCount < this.maxPingPongCount) {
          this.pingPongCount++
          process.nextTick(() => this.emit('pong'))
        }
      }

      close () {
        if (this.readyState < 2) {
          this.readyState = 2
          process.nextTick(() => {
            this.readyState = 3
            this.emit('close')
          })
        }
      }

      terminate () {
        if (this.readyState < 2) {
          this.close()
        }
      }
    }

    class Agent {
      destroy () {}
    }

    class TestPager {
      constructor () {
        this.pageSize = 7
      }

      list () {
        return {
          items: []
        }
      }
    }

    class TestListWatcher {
      constructor (socket) {
        this.agent = new Agent()
        this.group = ''
        this.version = 'v1'
        this.names = {
          kind: 'Dummy',
          plural: 'dummies'
        }
        this.socket = socket
        this.expiredErrorForToken = undefined
        this.messages = []
      }

      async list ({ limit, continue: continueToken }) {
        await nextTick()
        const metadata = {
          resourceVersion: '2',
          selfLink: 'link'
        }
        if (!continueToken) {
          if (limit !== 1) {
            return { metadata: { ...metadata }, items: [a, b] }
          }
          return { metadata: { continue: 'b', ...metadata }, items: [a] }
        }
        if (continueToken === this.expiredErrorForToken) {
          throw new ApiErrors.StatusError({
            code: 410,
            reason: 'Expired',
            message: 'Resource is expired'
          })
        }
        if (continueToken === 'b') {
          return {
            metadata: {},
            items: [b]
          }
        }
        throw new Error('Unexpected continue token')
      }

      watch (options) {
        this.socket = new TestSocket()
        while (this.messages.length) {
          this.socket.emit('message', this.messages.shift())
        }
        return this.socket
      }

      emitEvent (event) {
        const message = JSON.stringify(event)
        if (this.socket) {
          this.socket.emit('message', message)
        } else {
          this.messages.push(message)
        }
      }

      closeWatch () {
        this.socket.terminate()
      }
    }

    beforeEach(function () {
      map = new Map()
      store = new Store(map, { timeout: 1 })
      listWatcher = new TestListWatcher()
      destroyAgentSpy = sandbox.spy(listWatcher.agent, 'destroy')
    })

    describe('Store', function () {
      let clearSpy

      beforeEach(function () {
        clearSpy = sandbox.spy(store, 'clear')
      })

      it('should add, update and delete elements', async function () {
        expect(store).to.be.an.instanceof(Store)
        expect(store.isFresh).to.be.false

        // refresh
        store.setRefreshing()
        expect(store.isFresh).to.be.false

        // replace [a]
        store.replace([a])
        expect(store.isFresh).to.be.true
        expect(clearSpy).to.be.calledOnce
        clearSpy.resetHistory()
        expect(store.has(a)).to.be.true
        expect(store.get(a)).to.equal(a)
        expect(store.getByKey('a')).to.equal(a)
        expect(store.list()).to.eql([a])

        // add b
        store.add(b)
        expect(store.listKeys()).to.eql(['a', 'b'])

        // update a
        store.update(x)
        expect(store.listKeys()).to.eql(['a', 'b'])
        expect(store.getByKey('a')).to.equal(x)

        // delete b
        store.delete(b)
        expect(store.listKeys()).to.eql(['a'])

        store.setRefreshing()
        await pEvent(store, 'stale')
        expect(store.isFresh).to.be.false
      })
    })

    describe('ListPager', function () {
      it('should return a list of paginated results', async function () {
        const listPager = ListPager.create(listWatcher, { pageSize: 1 })
        expect(listPager).to.be.an.instanceof(ListPager)
        expect(listPager.pageSize).to.equal(1)
        expect(listPager.fullListIfExpired).to.be.true
        const options = { resourceVersion: '0' }
        const { metadata, items } = await listPager.list(options)
        expect(metadata).to.eql({
          resourceVersion: '2',
          selfLink: 'link',
          paginated: true
        })
        expect(items).to.eql([a, b])
      })

      it('should return a full list', async function () {
        const listPager = ListPager.create(listWatcher, { pageSize: 2 })
        expect(listPager).to.be.an.instanceof(ListPager)
        expect(listPager.pageSize).to.equal(2)
        expect(listPager.fullListIfExpired).to.be.true
        const options = { resourceVersion: '0' }
        const { metadata, items } = await listPager.list(options)
        expect(metadata).to.eql({
          resourceVersion: '2',
          selfLink: 'link'
        })
        expect(items).to.eql([a, b])
      })

      it('should throw an "Expired" error for the second page', async function () {
        listWatcher.expiredErrorForToken = 'b'
        const listPager = ListPager.create(listWatcher, { pageSize: 1, fullListIfExpired: false })
        expect(listPager).to.be.an.instanceof(ListPager)
        expect(listPager.pageSize).to.equal(1)
        expect(listPager.fullListIfExpired).to.be.false
        const options = { resourceVersion: '0' }
        try {
          await listPager.list(options)
          expect.fail('expected list to throw "Expired" error')
        } catch (err) {
          expect(ApiErrors.isExpiredError(err)).to.be.true
        }
        listPager.fullListIfExpired = true
        const { metadata, items } = await listPager.list(options)
        expect(metadata).to.eql({
          resourceVersion: '2',
          selfLink: 'link',
          paginated: true
        })
        expect(items).to.eql([a, b])
      })
    })

    describe('Reflector', function () {
      let reflector

      beforeEach(function () {
        reflector = Reflector.create(listWatcher, store)
        reflector.period = moment.duration(1)
        reflector.backoffManager.min = 1
        reflector.backoffManager.max = 10
      })

      afterEach(async function () {
        await reflector.stop()
        expect(destroyAgentSpy).to.be.calledOnce
      })

      it('should have property apiVersion', async function () {
        expect(reflector.apiVersion).to.equal('v1')
        listWatcher.group = 'test'
      })

      it('should have property kind', async function () {
        expect(reflector.kind).to.equal('Dummy')
      })

      it('should have property expectedTypeName', async function () {
        expect(reflector.expectedTypeName).to.equal('v1, Kind=Dummy')
        listWatcher.group = 'test'
        expect(reflector.expectedTypeName).to.equal('test/v1, Kind=Dummy')
      })

      it('should return a resourceVersion for listing', async function () {
        reflector.isLastSyncResourceVersionExpired = true
        expect(reflector.relistResourceVersion).to.equal('')
        reflector.isLastSyncResourceVersionExpired = false
        expect(reflector.relistResourceVersion).to.equal('0')
        reflector.lastSyncResourceVersion = '1'
        expect(reflector.relistResourceVersion).to.equal('1')
      })

      describe('#heartbeat', function () {
        it('should start the heartbeat', async function () {
          reflector.heartbeatInterval = moment.duration(1)
          const socket = new TestSocket({ maxPingPongCount: 3 })
          await reflector.heartbeat(socket)
          expect(socket.pingPongCount).to.equal(3)
        })
      })

      describe('#watchHandler', function () {
        it('should handle watch events', async function () {
          const error = { code: 410, reason: 'Expired' }
          const socket = new EventEmitter()

          function emitMessage (message, ms) {
            setTimeout(() => socket.emit('message', message), ms)
          }

          function emitEvent (event, ms) {
            emitMessage(JSON.stringify(event), ms)
          }

          emitEvent({ type: 'ADDED', object: a }, 1)
          emitEvent({ type: 'ADDED', object: b }, 2)
          emitEvent({ type: 'MODIFIED', object: b }, 3)
          emitEvent({ type: 'DELETED', object: a }, 5)
          emitEvent({ type: 'BOOKMARK', object: bookmark }, 6)
          emitEvent({ type: 'ERROR', object: error }, 7)

          emitMessage('{ERROR}', 4)
          emitEvent({ type: 'ADDED', object: {} }, 4)
          emitEvent({ type: 'PATCHED', object: a }, 4)

          try {
            await reflector.watchHandler(socket)
            expect.fail('expected watchHandler to throw an expired error')
          } catch (err) {
            expect(ApiErrors.isExpiredError(err)).to.be.true
          }

          expect(reflector.lastSyncResourceVersion).to.equal('9')
          expect(store.listKeys()).to.eql(['b'])
        })
      })

      describe('#listAndWatch', function () {
        const expiredError = new ApiErrors.StatusError({ code: 410, reason: 'Expired' })
        const connectionRefusedError = new Error('Connection refused')
        connectionRefusedError.code = 'ECONNREFUSED'
        const unexpectedError = new Error('Failed')
        let pager
        let socket
        let listStub
        let listOptions
        let watchStub
        let watchOptions
        let createPagerStub
        let heartbeatStub
        let watchHandlerStub
        let terminateSpy
        let closeStub

        beforeEach(function () {
          reflector.period = moment.duration(1)
          reflector.gracePeriod = moment.duration(1)
          reflector.minWatchTimeout = moment.duration(30, 'seconds')
          pager = new TestPager()
          socket = new EventEmitter()
          createPagerStub = sandbox.stub(ListPager, 'create').returns(pager)
          listStub = sandbox.stub(pager, 'list')
          watchStub = sandbox.stub(reflector.listWatcher, 'watch')
          socket.readyState = 0
          socket.terminate = () => {}
          terminateSpy = sandbox.spy(socket, 'terminate')
          socket.close = () => {}
          closeStub = sandbox.stub(socket, 'close')
          heartbeatStub = sandbox.stub(reflector, 'heartbeat').callsFake(() => {
            socket.isAlive = true
          })
          watchHandlerStub = sandbox.stub(reflector, 'watchHandler')
        })

        it('should list and fail', async function () {
          listStub.onCall(0).throws(unexpectedError)
          reflector.listAndWatch()
          expect(createPagerStub).to.be.calledOnce
          expect(listStub).to.be.calledOnce
          listOptions = listStub.getCall(0).args[0]
          expect(listOptions).to.eql({ resourceVersion: '0' })
        })

        it('should list, fall back to resourceVersion="" and fail', async function () {
          listStub.onCall(0).throws(expiredError)
          listStub.onCall(1).throws(unexpectedError)
          reflector.listAndWatch()
          expect(createPagerStub).to.be.calledOnce
          expect(listStub).to.be.calledTwice
          listOptions = listStub.getCall(0).args[0]
          expect(listOptions).to.eql({ resourceVersion: '0' })
          listOptions = listStub.getCall(1).args[0]
          expect(listOptions).to.eql({ resourceVersion: '' })
        })

        it('should list, retry to start watching and fail', async function () {
          listStub.callsFake(async () => {
            return {
              metadata: {
                resourceVersion: '2',
                paginated: true
              },
              items: [a, b]
            }
          })
          watchStub.onCall(0).callsFake(() => {
            process.nextTick(() => {
              socket.emit('error', connectionRefusedError)
            })
            return socket
          })
          watchStub.onCall(1).callsFake(() => {
            process.nextTick(() => {
              socket.readyState = 1
              socket.emit('error', expiredError)
            })
            return socket
          })
          closeStub.callsFake(() => {
            process.nextTick(() => {
              socket.readyState = 3
              socket.emit('close')
            })
          })
          await reflector.listAndWatch()
          expect(createPagerStub).to.be.calledOnce
          expect(listStub).to.be.calledOnce
          expect(listStub).to.be.calledOnce
          expect(watchStub).to.be.calledTwice
          watchOptions = watchStub.getCall(0).args[0]
          expect(watchOptions.allowWatchBookmarks).to.be.true
          expect(watchOptions.timeoutSeconds).to.be.within(30, 60)
          expect(watchOptions.resourceVersion).to.equal('2')
          watchOptions = watchStub.getCall(1).args[0]
          expect(watchOptions.allowWatchBookmarks).to.be.true
          expect(watchOptions.timeoutSeconds).to.be.within(30, 60)
          expect(watchOptions.resourceVersion).to.equal('2')
          expect(closeStub).to.be.calledTwice
          expect(store.listKeys()).to.eql(['a', 'b'])
        })

        it('should list, start watching and exit', async function () {
          listStub.callsFake(async () => {
            return {
              metadata: {
                resourceVersion: '2',
                paginated: true
              },
              items: [a, b]
            }
          })
          watchStub.callsFake(() => {
            process.nextTick(() => {
              reflector.stopRequested = true
              socket.readyState = 1
              socket.emit('open')
            })
            return socket
          })
          closeStub.callsFake(() => {
            process.nextTick(() => {
              socket.readyState = 3
              socket.emit('close')
            })
          })
          await reflector.listAndWatch()
          expect(createPagerStub).to.be.calledOnce
          expect(listStub).to.be.calledOnce
          expect(listStub).to.be.calledOnce
          expect(watchStub).to.be.calledOnce
          expect(closeStub).to.be.calledOnce
          expect(terminateSpy).not.to.be.called
        })

        it('should list, watch and fail', async function () {
          listStub.callsFake(async () => {
            return {
              metadata: {
                resourceVersion: '2'
              },
              items: [a, b]
            }
          })
          watchStub.callsFake(() => {
            process.nextTick(() => {
              socket.readyState = 1
              socket.emit('open')
            })
            return socket
          })
          watchHandlerStub.throws(unexpectedError)
          await reflector.listAndWatch()
          expect(createPagerStub).to.be.calledOnce
          expect(listStub).to.be.calledOnce
          expect(listStub).to.be.calledOnce
          expect(watchStub).to.be.calledOnce
          expect(heartbeatStub).to.be.calledOnceWithExactly(socket)
          expect(watchHandlerStub).to.be.calledOnceWithExactly(socket)
          expect(closeStub).to.be.calledOnce
          expect(terminateSpy).to.be.calledOnce
        })
      })

      describe('#run', function () {
        it('should run list and watch until stopped', async function () {
          const listAndWatchStub = sandbox.stub(reflector, 'listAndWatch')
          listAndWatchStub.onCall(0).throws('foo')
          listAndWatchStub.onCall(1).throws('bar')
          listAndWatchStub.onCall(2).callsFake(() => reflector.stop())
          await reflector.run()
          expect(listAndWatchStub).to.have.callCount(3)
          expect(destroyAgentSpy).to.be.calledOnce
          destroyAgentSpy.resetHistory()
        })

        it('should run a reflector', async function () {
          expect(reflector).to.be.an.instanceof(Reflector)
          reflector.run()
          await pEvent(store, 'fresh')
          expect(store.listKeys()).to.eql(['a', 'b'])
          await pEvent(listWatcher.socket, 'open')
          // wait until message loop has been established
          await nextTick()

          // add c
          listWatcher.emitEvent({ type: 'ADDED', object: c })
          // wait until added event has been handled
          await nextTick()
          expect(store.listKeys()).to.eql(['a', 'b', 'c'])
          // close websocket connection
          listWatcher.closeWatch()
          // delete c
          listWatcher.emitEvent({ type: 'DELETED', object: c })
          // wait until deleted event has been handled
          await nextTick()
          expect(store.listKeys()).to.eql(['a', 'b'])
        })
      })
    })
  })
})
