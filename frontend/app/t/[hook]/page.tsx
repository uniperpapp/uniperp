import { PerLaunchPage } from "@/components/PerLaunchPage";

// The `[hook]` segment accepts EITHER a hook address (launch redirect / activity
// links) OR a token address (directory tiles). PerLaunchPage resolves which.
export default function Page({ params }: { params: { hook: string } }) {
  return <PerLaunchPage addr={params.hook as `0x${string}`} />;
}
