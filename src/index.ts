import { definePlugin, type PluginContext, type Session } from '@qqbot/sdk'

export interface Config {
  apiKey: string
  model: string
  systemPrompt: string
  historyTurns: number
  memoryHours: number
  maxOutputTokens: number
  dailyRequests: number
}

interface Message { role: 'user' | 'assistant'; content: string }
interface Conversation { history: string; updated_at: number }
type Context = PluginContext<Config>

export const defaults: Config = {
  apiKey: '',
  model: 'deepseek-flash',
  systemPrompt: '你是QQ群里的AI聊天助手。用自然、友善的中文回答，除非对方要求其他语言。回答简明，尊重用户给出的上下文，不编造已完成的操作。你只有文字聊天能力，没有浏览器、外部工具或执行代码的能力。不要声称自己执行了外部操作。',
  historyTurns: 6,
  memoryHours: 24,
  maxOutputTokens: 600,
  dailyRequests: 100,
}

const HELP = '群里 @我 加上问题即可聊天；私聊直接发消息就行。\n/清空：清除你在这个会话里的聊天上下文。\n不同会话、不同成员的上下文分别保存。'
const INPUT_LIMIT = 3000
const ANSWER_LIMIT = 3000
const REQUEST_TIMEOUT = 20_000

function conversationId(session: Session): string {
  return JSON.stringify([session.botId, session.scene, session.targetId, session.userId])
}

function inScope(session: Session): boolean {
  // 群聊要求 @机器人；私聊直接聊天即可
  return session.scene === 'c2c' || (session.scene === 'group' && session.atMe)
}

function readHistory(row: Conversation | null, config: Config, now: number): Message[] {
  if (!row || row.updated_at < now - config.memoryHours * 3600_000) return []
  try {
    const value: unknown = JSON.parse(row.history)
    if (!Array.isArray(value)) return []
    return value.filter((m): m is Message => !!m &&
      (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-config.historyTurns * 2)
  } catch { return [] }
}

function publicApiError(status: number): string {
  if (status === 401 || status === 403) return 'DeepSeek 密钥未通过验证，请管理员检查插件配置。'
  if (status === 402) return 'DeepSeek API 余额不足，请管理员检查余额。'
  if (status === 429) return 'DeepSeek 当前请求较多，请稍后再试。'
  if (status === 400 || status === 404) return 'DeepSeek 模型或请求配置有误，请管理员检查插件配置。'
  return 'DeepSeek 服务暂时不可用，请稍后再试。'
}

async function askApi(ctx: Context, history: Message[], question: string): Promise<{ answer?: string; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      // Workers 不支持 redirect:error；manual 同样防止密钥跟随重定向。
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.config.apiKey.trim()}` },
      body: JSON.stringify({
        model: ctx.config.model,
        messages: [{ role: 'system', content: ctx.config.systemPrompt }, ...history, { role: 'user', content: question }],
        thinking: { type: 'disabled' },
        max_tokens: ctx.config.maxOutputTokens,
        stream: false,
      }),
    })
    if (!response.ok) {
      ctx.logger.warn('DeepSeek 请求未成功', { status: response.status })
      await response.body?.cancel().catch(() => {})
      return { error: publicApiError(response.status) }
    }
    const body: unknown = await response.json()
    const content = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) return { error: '模型没有返回文字，请换个说法再试。' }
    const text = content.trim()
    const answer = text.length > ANSWER_LIMIT ? `${text.slice(0, ANSWER_LIMIT)}\n（回答较长，已截断）` : text
    return { answer }
  } catch (error) {
    // 不回显原始异常、响应体或密钥，也不自动重试付费请求。
    const kind = error instanceof Error && ['TypeError', 'SyntaxError', 'AbortError'].includes(error.name) ? error.name : 'Error'
    ctx.logger.warn('DeepSeek 请求异常', { kind, timeout: controller.signal.aborted })
    return { error: controller.signal.aborted ? '这次回答超时了，请缩短问题后再试。' : '暂时无法连接 DeepSeek，请稍后再试。' }
  } finally { clearTimeout(timer) }
}

async function acquire(ctx: Context, key: string, lease: string, now: number): Promise<boolean> {
  const result = await ctx.db.run(`
    INSERT INTO {conversations} (id, history, updated_at, lease, locked_until)
    VALUES (?, '[]', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET lease = excluded.lease, locked_until = excluded.locked_until
    WHERE {conversations}.locked_until <= ?
  `, key, now, lease, now + 60_000, now)
  return result.changes === 1
}

async function release(ctx: Context, key: string, lease: string): Promise<void> {
  await ctx.db.run('UPDATE {conversations} SET lease = ?, locked_until = 0 WHERE id = ? AND lease = ?', '', key, lease)
}

export async function chat(session: Session, ctx: Context, rawQuestion: string): Promise<void> {
  if (!inScope(session)) return
  const question = rawQuestion.trim()
  if (!question) { await session.reply(HELP); return }
  if (question.length > INPUT_LIMIT) { await session.reply(`问题太长了，请控制在 ${INPUT_LIMIT} 个字符以内。`); return }
  if (!ctx.config.apiKey.trim()) { await session.reply('聊天服务还未配置，请管理员在插件设置里填写 DeepSeek API Key。'); return }

  const key = conversationId(session)
  const lease = crypto.randomUUID()
  let locked = false
  try {
    const now = Date.now()
    locked = await acquire(ctx, key, lease, now)
    if (!locked) { await session.reply('我还在回答你上一个问题，请稍等再发。'); return }

    const day = new Date(now).toISOString().slice(0, 10)
    const quota = await ctx.db.run(`
      INSERT INTO {daily_usage} (day, requests) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET requests = requests + 1
      WHERE {daily_usage}.requests < ?
    `, day, ctx.config.dailyRequests)
    if (quota.changes !== 1) { await session.reply('今天的 AI 调用次数已用完，明天再聊吧。'); return }

    const row = await ctx.db.first<Conversation>('SELECT history, updated_at FROM {conversations} WHERE id = ? AND lease = ?', key, lease)
    const history = readHistory(row, ctx.config, now)
    const result = await askApi(ctx, history, question)
    if (!result.answer) { await session.reply(result.error ?? '暂时无法回答，请稍后再试。'); return }

    // 分为最多三条被动回复；只有全部发送成功，才把这次对话写进上下文。
    for (let offset = 0; offset < result.answer.length; offset += 1500) {
      const sent = await session.reply(result.answer.slice(offset, offset + 1500))
      if (!sent.ok) { ctx.logger.warn('QQ 回复发送失败', { status: sent.status }); return }
    }
    const next = [...history, { role: 'user', content: question }, { role: 'assistant', content: result.answer }]
      .slice(-ctx.config.historyTurns * 2)
    await ctx.db.run('UPDATE {conversations} SET history = ?, updated_at = ? WHERE id = ? AND lease = ?', JSON.stringify(next), Date.now(), key, lease)
  } catch {
    ctx.logger.warn('聊天处理失败；请检查数据库绑定和服务状态')
    await session.reply('聊天服务暂时出现问题，请稍后再试。')
  } finally {
    if (locked) await release(ctx, key, lease).catch(() => ctx.logger.warn('会话锁释放失败，将自动过期'))
  }
}

async function reset(session: Session, ctx: Context): Promise<void> {
  if (!inScope(session)) return
  const key = conversationId(session)
  const lease = crypto.randomUUID()
  const locked = await acquire(ctx, key, lease, Date.now())
  if (!locked) { await session.reply('我还在回答你上一个问题，请回答结束后再清空。'); return }
  try {
    await ctx.db.run('UPDATE {conversations} SET history = ?, updated_at = ? WHERE id = ? AND lease = ?', '[]', Date.now(), key, lease)
    await session.reply('已清空你在这个会话里的聊天上下文。')
  } finally { await release(ctx, key, lease) }
}

export default definePlugin<Config>({
  name: 'deepseek',
  apiVersion: 1,
  displayName: 'DeepSeek 聊天',
  description: 'QQ 群 @机器人 或私聊连续聊天，按会话和用户保存上下文',
  permissions: ['net', 'db'],
  defaultConfig: defaults,
  configSchema: {
    type: 'object',
    properties: {
      apiKey: { type: 'string', title: 'DeepSeek API Key', writeOnly: true, description: '仅填官方 DeepSeek 密钥。请求固定发送到 `https://api.deepseek.com`。' },
      model: { type: 'string', title: '模型', enum: ['deepseek-flash', 'deepseek-v4-pro'], default: defaults.model },
      systemPrompt: { type: 'string', title: '角色设定', format: 'textarea', minLength: 1, maxLength: 4000, default: defaults.systemPrompt },
      historyTurns: { type: 'integer', title: '保留对话轮数', minimum: 1, maximum: 10, default: defaults.historyTurns },
      memoryHours: { type: 'integer', title: '上下文有效小时数', minimum: 1, maximum: 168, default: defaults.memoryHours },
      maxOutputTokens: { type: 'integer', title: '每次最多生成 Token', minimum: 64, maximum: 1200, default: defaults.maxOutputTokens },
      dailyRequests: { type: 'integer', title: '全机器人每日最多调用次数（UTC重置）', minimum: 1, maximum: 1000, default: defaults.dailyRequests },
    },
    required: ['apiKey', 'model', 'systemPrompt', 'historyTurns', 'memoryHours', 'maxOutputTokens', 'dailyRequests'],
  },
  hooks: {
    async onBoot(ctx) {
      await ctx.db.exec(`
        CREATE TABLE IF NOT EXISTS {conversations} (
          id TEXT PRIMARY KEY, history TEXT NOT NULL, updated_at INTEGER NOT NULL,
          lease TEXT NOT NULL DEFAULT '', locked_until INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS {daily_usage} (day TEXT PRIMARY KEY, requests INTEGER NOT NULL);
      `)
    },
  },
  commands: {
    ai: { description: '和AI聊天', usage: '/ai 问题', scenes: ['group', 'c2c'], handler: ({ session, ctx, argText }) => chat(session, ctx, argText) },
    clear: { aliases: ['清空'], description: '清空我的聊天记忆', scenes: ['group', 'c2c'], handler: ({ session, ctx }) => reset(session, ctx) },
    aihelp: { aliases: ['聊天帮助'], description: '聊天使用说明', scenes: ['group', 'c2c'], handler: ({ session }) => inScope(session) ? HELP : undefined },
  },
  regex: {
    '[\\s\\S]+': {
      priority: -100, scenes: ['group', 'c2c'],
      handler: ({ session, ctx }) => {
        if (!session.content.trimStart().startsWith('/')) return chat(session, ctx, session.content)
      },
    },
  },
  cron: {
    cleanup: {
      cron: '0 0 * * *',
      async handler({ ctx }) {
        const now = Date.now()
        await ctx.db.run('DELETE FROM {conversations} WHERE updated_at < ? AND locked_until <= ?', now - ctx.config.memoryHours * 3600_000, now)
        await ctx.db.run('DELETE FROM {daily_usage} WHERE day < ?', new Date(now - 7 * 86400_000).toISOString().slice(0, 10))
      },
    },
  },
})
