import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import type { ConfigFields } from '../shared/config-fields';

export function GuidedConfigFields({ provider, value, change, disabled }: { provider: 'claude' | 'codex'; value: ConfigFields; change: (value: ConfigFields) => void; disabled: boolean }) {
  const [show, setShow] = useState(false);
  const update = (patch: Partial<ConfigFields>) => change({ ...value, ...patch });
  const choices = (label: string, options: [string, string][], selected: string, pick: (id: string) => void) => <fieldset className="config-options" disabled={disabled}><legend>{label}</legend><div role="group" aria-label={label}>{options.map(([id, text]) => <button type="button" key={id} aria-pressed={id === selected} className={id === selected ? 'selected' : ''} onClick={() => pick(id)}>{text}</button>)}</div></fieldset>;
  return <div className="guided-config">
    {choices('连接方式', [['keep', '保留当前连接'], ['official', '官方登录'], ['custom', '自定义 API']], value.connection, id => update({ connection: id as ConfigFields['connection'] }))}
    {value.connection === 'keep' && <p className="config-help">仅修改下方模型与思考程度，沿用当前连接和鉴权。API 服务商、密钥等设置可在“自定义 API”中填写。</p>}
    {value.connection === 'official' && <p className="config-help">使用服务器上已完成的官方账号登录。保存后会切回官方连接；需要先在服务器完成登录，已有登录凭据会保留。</p>}
    {value.connection === 'custom' && <>
      {provider === 'codex' && <label className="field">服务商编号<input aria-label="服务商编号" disabled={disabled} value={value.providerId} onChange={e => update({ providerId: e.target.value, secret: '' })} autoCapitalize="off" spellCheck={false}/><small>用于 model_providers 的内部编号，例如 relquay_custom。</small></label>}
      <label className="field">API 服务地址<input aria-label="API 服务地址" type="url" disabled={disabled} value={value.baseUrl} onChange={e => update({ baseUrl: e.target.value, secret: '' })} placeholder={provider === 'codex' ? 'https://api.example.com/v1' : 'https://api.example.com'} autoCapitalize="off" spellCheck={false}/><small>{provider === 'codex' ? '填写服务器可访问的 Responses 兼容 API 根地址，通常以 /v1 结尾；不要追加 /responses。' : '填写服务器可访问的 Anthropic Messages 兼容根地址，不要追加 /v1/messages。'} 修改地址会清空表单密钥，请重新填写。</small></label>
      {provider === 'codex' ? choices('密钥来源', [['inline', '填写 API Key'], ['env', '服务器环境变量']], value.credential, id => update({ credential: id as ConfigFields['credential'] })) : choices('鉴权方式', [['token', 'Bearer Token'], ['key', 'API Key']], value.claudeAuth, id => update({ claudeAuth: id as ConfigFields['claudeAuth'] }))}
      {provider === 'codex' && value.credential === 'env' ? <label className="field">环境变量名称<input aria-label="密钥环境变量" value={value.envKey} onChange={e => update({ envKey: e.target.value })} disabled={disabled} autoCapitalize="off" spellCheck={false}/><small>只填写名称，例如 OPENAI_API_KEY。值需要事先配置在服务器代理进程的环境中。</small></label> : <label className="field">{provider === 'claude' && value.claudeAuth === 'token' ? 'Bearer Token' : 'API Key'}<span className="config-secret"><input aria-label="API 密钥" type={show ? 'text' : 'password'} value={value.secret} onChange={e => update({ secret: e.target.value })} disabled={disabled} autoComplete="off" autoCapitalize="off" spellCheck={false}/><button type="button" className="icon-button" aria-label={show ? '隐藏密钥' : '显示密钥'} onClick={() => setShow(!show)}>{show ? <EyeOff size={17}/> : <Eye size={17}/>}</button></span><small>{provider === 'codex' ? '保存到此服务商的 experimental_bearer_token；也可选用环境变量。' : value.claudeAuth === 'token' ? '使用 env.ANTHROPIC_AUTH_TOKEN，请输入原始密钥，不加 Bearer 前缀。' : '使用 env.ANTHROPIC_API_KEY，作为 X-Api-Key 请求头。'}</small></label>}
    </>}
    <label className="field">模型 ID<input aria-label="默认模型 ID" value={value.model} onChange={e => update({ model: e.target.value })} disabled={disabled} placeholder={provider === 'codex' ? '服务商支持的模型 ID' : '例如 sonnet，或服务商提供的完整 ID'} autoCapitalize="off" spellCheck={false}/><small>{provider === 'codex' ? '对应 model。模型 ID 以 API 服务商文档为准。' : '对应 model；已有 ANTHROPIC_MODEL 时也同步更新。'} 对话中已选择的模型仍优先使用。</small></label>
    <label className="field">默认思考程度<input aria-label="默认思考程度" value={value.effort} onChange={e => update({ effort: e.target.value })} disabled={disabled} placeholder="留空使用代理默认" autoCapitalize="off" spellCheck={false}/><small>{provider === 'codex' ? '对应 model_reasoning_effort，例如 low / medium / high / xhigh，需模型支持。' : '对应 effortLevel，例如 low / medium / high；具体选项取决于模型。'}</small></label>
    {choices('常用思考程度', [['', '代理默认'], ['low', '低'], ['medium', '中'], ['high', '高'], ...(provider === 'codex' ? [['xhigh', '极高'] as [string, string]] : [])], value.effort, effort => update({ effort }))}
    <p className="inline-note">引导填写会整理 JSON/TOML 格式，TOML 注释会移除；其他配置值保留。可切到源码编辑检查完整草稿，点击保存才写入服务器。</p>
  </div>;
}
