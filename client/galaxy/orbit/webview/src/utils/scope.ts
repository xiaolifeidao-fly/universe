/**
 * 一把密钥的允许范围。
 *
 * 服务端有同一套（consumerkey.go 的 kindAllowed / modelAllowed，请求路径上的
 * AuthorizeRoute 用的也是它们）。**服务端那份说了算** —— 这里这份只为一件事：
 * 别在界面上摆出一个点下去必然被拒的选项。
 *
 * 为什么这件事值得在前端也算一遍：额度按模型分账之后，把一份 Opus 的额度充进
 * 一把只允许 Haiku 的密钥，余额是写得进去的，请求却会被挡下来 —— 额度到手即死。
 * 服务端已经会拒，但让人先填完一整单再收一个错误，不如一开始就别让他选。
 */

/** 和服务端 contract.matchPattern 一致：`*` 全放，`claude-*` 放整族，其余精确相等。 */
function matchPattern(value: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;
  if (trimmed.endsWith("*")) return value.startsWith(trimmed.slice(0, -1));
  return value === trimmed;
}

/** 空名单 = 不限。和服务端 contract.ModelMatch 的 allow 为空时放行一致。 */
export function modelAllowed(tiers: string[] | undefined, model: string): boolean {
  if (!model) return true;
  const list = tiers ?? [];
  if (list.length === 0) return true;
  return list.some((pattern) => matchPattern(model, pattern));
}

export function kindAllowed(kinds: string[] | undefined, kind: string): boolean {
  if (!kind) return true;
  const list = kinds ?? [];
  return list.length === 0 || list.includes(kind);
}

/** 这把密钥收不收得下这一单买的东西（一组「能力 + 模型」）。 */
export function canReceive(
  key: { allowedKinds?: string[]; modelTier?: string[] },
  items: Array<{ kind?: string; modelId: string }>,
): boolean {
  return items.every((item) => kindAllowed(key.allowedKinds, item.kind ?? "") && modelAllowed(key.modelTier, item.modelId));
}
