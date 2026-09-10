import { redirect } from "next/navigation";

import { productConfig } from "@/utils/product";

export default function RootPage() {
  redirect(productConfig.home);
}
