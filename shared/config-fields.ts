import { parse, stringify, type TomlTable } from 'smol-toml';
import type { AgentConfig } from './agent-config';

type Provider = AgentConfig['provider'];
export type ConfigFields = { connection: 'keep' | 'official' | 'custom'; model: string; effort: string; providerId: string; baseUrl: string; credential: 'inline' | 'env'; secret: string; envKey: string; claudeAuth: 'token' | 'key' };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
function document(provider: Provider, source: string) {
  try {
    const value: unknown = provider === 'codex' ? parse(source) : JSON.parse(source || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error('当前源码格式有误，请先在源码编辑中修正 JSON/TOML'); }
}
export function readConfigFields(provider: Provider, source: string): ConfigFields {
  const value = document(provider, source), env = record(value.env), id = text(value.model_provider), entry = record(record(value.model_providers)[id]);
  if (provider === 'claude' && Object.hasOwn(value, 'env') && (!value.env || typeof value.env !== 'object' || Array.isArray(value.env))) throw new Error('env 需要是对象，请在源码编辑中修正');
  return { connection: 'keep', model: text(provider === 'claude' ? env.ANTHROPIC_MODEL ?? value.model : value.model), effort: text(provider === 'claude' ? env.CLAUDE_CODE_EFFORT_LEVEL ?? value.effortLevel : value.model_reasoning_effort), providerId: id && !['openai', 'ollama', 'lmstudio'].includes(id) ? id : 'roamdeck_custom', baseUrl: text(provider === 'claude' ? env.ANTHROPIC_BASE_URL : entry.base_url), credential: entry.env_key ? 'env' : 'inline', envKey: text(entry.env_key) || 'OPENAI_API_KEY', secret: text(provider === 'claude' ? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY : entry.experimental_bearer_token), claudeAuth: env.ANTHROPIC_AUTH_TOKEN ? 'token' : env.ANTHROPIC_API_KEY ? 'key' : 'token' };
}
function setText(target: Record<string, unknown>, key: string, input: string) { if (input.trim()) target[key] = input.trim(); else delete target[key]; }
export function applyConfigFields(provider: Provider, source: string, fields: ConfigFields): string {
  const original = readConfigFields(provider, source);
  if (JSON.stringify(original) === JSON.stringify(fields)) return source;
  const value = document(provider, source);
  if (fields.model.length > 200 || fields.effort.length > 60 || /[\r\n]/.test(fields.model + fields.effort)) throw new Error('模型或思考程度填写过长，或包含换行');
  const env = record(value.env);
  if (fields.model !== original.model) { setText(value, 'model', fields.model); if (provider === 'claude' && Object.hasOwn(env, 'ANTHROPIC_MODEL')) setText(env, 'ANTHROPIC_MODEL', fields.model); }
  if (fields.effort !== original.effort) { setText(value, provider === 'codex' ? 'model_reasoning_effort' : 'effortLevel', fields.effort); if (provider === 'claude' && Object.hasOwn(env, 'CLAUDE_CODE_EFFORT_LEVEL')) setText(env, 'CLAUDE_CODE_EFFORT_LEVEL', fields.effort); }
  if (fields.connection !== 'keep') {
    if (provider === 'claude' && value.apiKeyHelper) throw new Error('当前使用密钥命令，请通过源码编辑切换鉴权；引导不会移除它');
    if (provider === 'claude' && ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => env[key] && !['0', 'false'].includes(String(env[key])))) throw new Error('当前使用云平台连接，请通过源码编辑切换；引导不会移除这些配置');
    if (fields.connection === 'official') {
      if (provider === 'codex') value.model_provider = 'openai';
      else for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) delete env[key];
    } else {
      let url: URL;
      try { url = new URL(fields.baseUrl.trim()); } catch { throw new Error('请填写完整的 API 服务地址，例如 https://api.example.com/v1'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址需为 HTTP(S)，不要包含账号密码、查询参数或片段');
      if (!fields.model.trim()) throw new Error('自定义 API 需要填写服务商实际支持的模型 ID');
      if (provider === 'claude') {
        if (!fields.secret.trim() || /[\r\n]/.test(fields.secret)) throw new Error('请填写有效密钥，不要包含换行');
        env.ANTHROPIC_BASE_URL = fields.baseUrl.trim();
        delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
        env[fields.claudeAuth === 'token' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = fields.secret.trim();
      } else {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(fields.providerId) || ['openai', 'ollama', 'lmstudio'].includes(fields.providerId)) throw new Error('服务商编号使用字母开头的字母、数字、下划线或短横线，不能占用内置编号');
        const providers = record(value.model_providers), entry = { ...record(providers[fields.providerId]) };
        if (entry.auth || entry.aws || entry.gateway_oauth || Object.keys(record(entry.http_headers)).some(key => /^(authorization|x-api-key)$/i.test(key))) throw new Error('此服务商已有高级鉴权，请使用源码编辑或填写新的服务商编号');
        if (entry.wire_api && entry.wire_api !== 'responses') throw new Error('此服务商使用其他协议，请通过源码编辑配置');
        entry.name = typeof entry.name === 'string' ? entry.name : fields.providerId;
        entry.base_url = fields.baseUrl.trim(); entry.wire_api = 'responses'; entry.requires_openai_auth = false;
        delete entry.experimental_bearer_token; delete entry.env_key;
        if (fields.credential === 'env') {
          if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(fields.envKey)) throw new Error('请填写服务器环境变量名称，例如 OPENAI_API_KEY');
          entry.env_key = fields.envKey;
        } else {
          if (!fields.secret.trim() || /[\r\n]/.test(fields.secret)) throw new Error('请填写有效密钥，或选择服务器环境变量');
          entry.experimental_bearer_token = fields.secret.trim();
        }
        providers[fields.providerId] = entry; value.model_providers = providers; value.model_provider = fields.providerId;
      }
    }
  }
  if (provider === 'claude' && (Object.hasOwn(value, 'env') || Object.keys(env).length)) value.env = env;
  return provider === 'codex' ? stringify(value as TomlTable) : JSON.stringify(value, null, 2) + '\n';
}
