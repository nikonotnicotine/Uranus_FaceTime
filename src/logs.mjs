/**
 * 日志。
 *
 * 节点是独立进程、常常跑在一台只有 SSH 的机器上，所以就是往 stdout 打。
 * 格式和 Uranus 那边对齐（`scope` 用中文、第二个参数是一句人话、第三个是详情），
 * 方便两边的日志拼在一起看。
 *
 * 真正重要的事件另外会通过 `/facetime/status` 报给 Uranus，在控制台里能看到 ——
 * 这里打的是排查用的细节。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS[process.env.FT_LOG_LEVEL] ?? LEVELS.info;

/** 调一次就能把 debug 打开，排查时用。 */
export function setLogLevel(name) {
  threshold = LEVELS[name] ?? threshold;
}

function emit(level, scope, message, detail) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toTimeString().slice(0, 8);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${scope} ${message}`;
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(`${line}\n`);
  if (detail !== undefined) {
    const text = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
    // 详情缩进两格，和上面那行区分开
    out.write(`${text.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
  }
}

export const logDebug = (scope, message, detail) => emit("debug", scope, message, detail);
export const logInfo = (scope, message, detail) => emit("info", scope, message, detail);
export const logWarn = (scope, message, detail) => emit("warn", scope, message, detail);
export const logError = (scope, message, detail) => emit("error", scope, message, detail);
