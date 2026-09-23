export type Product = 'nova' | 'orbit';
export const products: Record<Product, { name: string; role: string; basePath: string; home: string; port: number }>;
export const defaultOrigin: string;
export const defaultUpdateFeed: string;
export interface DesktopAPI { product: Product }
declare global { interface Window { galaxyDesktop?: DesktopAPI } }
