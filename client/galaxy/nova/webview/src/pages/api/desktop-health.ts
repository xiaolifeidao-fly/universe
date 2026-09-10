import type { NextApiRequest, NextApiResponse } from 'next';
import { product } from '../../utils/product';
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ product });
}
