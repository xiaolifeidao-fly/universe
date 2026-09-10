export type Product = 'nova' | 'orbit';
export const products: Record<Product, { name: string; role: string; home: string; port: number }>;
export interface DesktopAPI { product: Product }
declare global { interface Window { galaxyDesktop?: DesktopAPI } }
