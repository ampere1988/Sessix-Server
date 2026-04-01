/** 统一结果类型，替代 try/catch */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E }
