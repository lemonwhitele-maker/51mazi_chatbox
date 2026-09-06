import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { parseCustomHeaders, requestAgent } from '../src/renderer/src/service/antigravityClient.ts'

const payload = {
  prompt: 'test',
  selection: 'old',
  full_text: 'old full text',
  cursor_position: 1,
  metadata: { chapter_id: 'chapter-1' }
}

function encodeWebSocketFrame(value, opcode = 0x1) {
  const body = Buffer.from(value)
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length])
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([header, body])
}

function consumeClientFrames(socket, onText) {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f
      const masked = Boolean(buffer[1] & 0x80)
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLength = masked ? 4 : 0
      if (buffer.length < offset + maskLength + length) return
      const mask = masked ? buffer.subarray(offset, offset + 4) : null
      offset += maskLength
      const body = Buffer.from(buffer.subarray(offset, offset + length))
      buffer = buffer.subarray(offset + length)
      if (mask) {
        for (let index = 0; index < body.length; index += 1) {
          body[index] ^= mask[index % 4]
        }
      }
      if (opcode === 0x1) onText(body.toString('utf8'))
      if (opcode === 0x8) {
        socket.write(encodeWebSocketFrame(body, 0x8))
        socket.end()
      }
    }
  })
}

async function startServer() {
  const observed = { headers: null, websocketPayload: null }
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    if (request.url === '/json') {
      observed.headers = request.headers
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          data: {
            type: 'diff',
            original_text: 'old',
            replacement_text: 'new'
          }
        })
      )
      return
    }
    if (request.url === '/sse') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"delta":"Hello "}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n')
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(404).end()
  })

  server.on('upgrade', (request, socket) => {
    if (request.url !== '/ws') {
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    consumeClientFrames(socket, (text) => {
      if (observed.websocketPayload) return
      observed.websocketPayload = JSON.parse(text)
      socket.write(encodeWebSocketFrame(JSON.stringify({ delta: 'WS ' })))
      socket.write(encodeWebSocketFrame(JSON.stringify({ content: 'works' })))
      socket.write(
        encodeWebSocketFrame(
          JSON.stringify({
            type: 'diff',
            original_text: 'old',
            replacement_text: 'new over ws'
          })
        )
      )
      socket.write(encodeWebSocketFrame('[DONE]'))
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    server,
    observed,
    port: typeof address === 'object' && address ? address.port : 0
  }
}

const fixture = await startServer()
const baseConfig = {
  transport: 'http',
  apiKey: 'secret',
  customHeaders: '{"X-Agent-Test":"yes"}'
}

try {
  assert.deepEqual(parseCustomHeaders('{"X-Test":123}'), { 'X-Test': '123' })
  assert.throws(() => parseCustomHeaders('[]'), /JSON 对象/)

  const json = await requestAgent(payload, {
    ...baseConfig,
    endpoint: `http://127.0.0.1:${fixture.port}/json`
  })
  assert.equal(json.diff?.originalText, 'old')
  assert.equal(json.diff?.replacementText, 'new')
  assert.equal(fixture.observed.headers.authorization, 'Bearer secret')
  assert.equal(fixture.observed.headers['x-agent-test'], 'yes')

  const deltas = []
  const sse = await requestAgent(
    payload,
    { ...baseConfig, endpoint: `http://127.0.0.1:${fixture.port}/sse` },
    { onText: (delta) => deltas.push(delta) }
  )
  assert.equal(sse.text, 'Hello world')
  assert.deepEqual(deltas, ['Hello ', 'world'])

  const websocket = await requestAgent(payload, {
    ...baseConfig,
    transport: 'websocket',
    endpoint: `ws://127.0.0.1:${fixture.port}/ws`
  })
  assert.equal(websocket.text, 'WS works')
  assert.equal(websocket.diff?.replacementText, 'new over ws')
  assert.equal(fixture.observed.websocketPayload.prompt, payload.prompt)
  assert.equal(fixture.observed.websocketPayload.headers.Authorization, 'Bearer secret')

  console.log(
    JSON.stringify(
      {
        success: true,
        customHeaders: true,
        jsonDiff: true,
        sseStreaming: true,
        websocketStreamingAndDiff: true
      },
      null,
      2
    )
  )
} finally {
  await new Promise((resolve) => fixture.server.close(resolve))
}
