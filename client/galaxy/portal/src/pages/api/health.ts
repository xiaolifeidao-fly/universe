import type { NextApiRequest, NextApiResponse } from "next";

/** 部署探活。门户没有桌面壳，不需要 desktop-health 那套产品校验。 */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ product: "portal", ok: true });
}
