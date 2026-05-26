import { Header } from "@/components/Header";
import { ChainGuard } from "@/components/ChainGuard";
import { LaunchForm } from "@/components/LaunchForm";

export default function Page() {
  return (
    // md:h-screen locks viewport height on desktop so the inner main scrolls
    // (same pattern as the migration page). On mobile, min-h-screen lets the
    // page scroll naturally.
    <div className="min-h-screen md:h-screen flex flex-col bg-bg text-text">
      <ChainGuard />
      <Header />
      <main className="flex-1 min-h-0 overflow-y-auto">
        <LaunchForm />
      </main>
    </div>
  );
}
