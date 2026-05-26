import { Header } from "@/components/Header";
import { ChainGuard } from "@/components/ChainGuard";
import { LaunchpadDirectory } from "@/components/LaunchpadDirectory";

/// Home = the launchpad directory. The original uniperp v2 trade UI now
/// lives at /perp (the `$PERP` nav link).
export default function Page() {
  return (
    <div className="min-h-screen md:h-screen flex flex-col bg-bg text-text">
      <ChainGuard />
      <Header />
      <main className="flex-1 min-h-0 flex flex-col">
        <LaunchpadDirectory />
      </main>
    </div>
  );
}
