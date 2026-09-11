import { z } from 'zod';

// token 能碰哪些模块。"*" 是全部。
//
// 这份枚举在原生模块里也有一份（config/schema.rs 的 Scope）—— 那边是权威，
// 这边只用来在 IPC 入口挡住不合法的入参，把错误在薄壳这一层就说清楚。
export const SCOPES = ['relay:anthropic', 'relay:openai', 'agent', 'admin', '*'] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;
