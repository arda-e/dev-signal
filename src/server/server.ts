import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit} from '@devvit/web/server'
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import {
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type GetCounterRsp,
  type IncCounterReq,
  type IncCounterRsp,
} from '../shared/api.ts'
import {runCollector} from './collector.ts'
import {dbGetCounter, dbIncCounter} from './db.ts'
import {publishNextTopic} from './publisher.ts'

type AnyRsp =
  | GetCounterRsp
  | IncCounterRsp
  | UiResponse
  | TriggerResponse
  | ErrorRsp

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson<ErrorRsp>(
      500,
      {error: 'Internal server error', status: 500},
      rspMsg,
    )
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  if (
    reqMsg.method === 'POST' &&
    reqMsg.url === '/internal/scheduler/devsignal-scan'
  ) {
    const result = await runCollector()
    console.log('Scheduled scan:', JSON.stringify(result))
    writeJson<PartialJsonValue>(
      result.status === 'partial' ? 500 : 200,
      result,
      rspMsg,
    )
    return
  }
  if (
    reqMsg.method === 'POST' &&
    reqMsg.url === '/internal/menu/devsignal-scan'
  ) {
    const result = await runCollector()
    console.log('Manual scan:', JSON.stringify(result))
    writeJson<UiResponse>(
      200,
      {
        showToast: {
          text:
            result.status === 'busy'
              ? 'A scan is already running; try again shortly.'
              : result.status === 'ok'
                ? 'Scan chunk completed. Check server logs.'
                : 'Scan chunk had errors. Check server logs.',
          appearance: result.status === 'ok' ? 'success' : 'neutral',
        },
      },
      rspMsg,
    )
    return
  }

  if (
    reqMsg.method === 'POST' &&
    (reqMsg.url === '/internal/scheduler/devsignal-publish' ||
      reqMsg.url === '/internal/menu/devsignal-publish')
  ) {
    const result = await publishNextTopic()
    console.log('Topic publisher:', JSON.stringify(result))
    if (reqMsg.url === '/internal/menu/devsignal-publish') {
      writeJson<UiResponse>(
        200,
        {
          showToast: {
            text: result.message,
            appearance: result.status === 'published' ? 'success' : 'neutral',
          },
          ...(result.url ? {navigateTo: result.url} : {}),
        },
        rspMsg,
      )
    } else writeJson<PartialJsonValue>(200, result, rspMsg)
    return
  }

  const endpoint = reqMsg.url?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.GetCounter:
        rsp = await routeGetCounter()
        break
      case Endpoint.IncCounter:
        rsp = await routeInc(reqMsg)
        break
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
        break
      case Endpoint.OnAppInstall:
        rsp = await routeAppInstall()
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

async function routeGetCounter(): Promise<GetCounterRsp> {
  const t3 = context.postId
  if (!t3) throw Error('no t3')
  return {count: await dbGetCounter(t3)}
}

async function routeInc(reqMsg: IncomingMessage): Promise<IncCounterRsp> {
  const t3 = context.postId
  if (!t3) throw Error('no t3')
  const req = await readJson<IncCounterReq>(reqMsg)
  return {count: await dbIncCounter(t3, req.amount)}
}

async function routeMenuNewPost(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({title: context.appSlug})
  return {
    showToast: {text: `Post ${post.id} created.`, appearance: 'success'},
    navigateTo: post.url,
  }
}

async function routeAppInstall(): Promise<TriggerResponse> {
  await reddit.submitCustomPost({title: context.appSlug})
  return {}
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  reqMsg.on('data', chunk => chunks.push(chunk))
  await once(reqMsg, 'end')
  return JSON.parse(`${Buffer.concat(chunks)}`)
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
