export function quotaReset(value: string, now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return { absolute: '未提供有效时间', remaining: '重置时间未知' };
  const absolute = new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'shortOffset' }).format(time);
  const minutes = Math.max(0, Math.ceil((time - now) / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  const remaining = minutes === 0 ? '已到重置时间，等待刷新' : `${days ? days + ' 天 ' : ''}${hours ? hours + ' 小时 ' : ''}${rest || (!days && !hours) ? rest + ' 分钟' : ''}后重置`;
  return { absolute, remaining };
}
