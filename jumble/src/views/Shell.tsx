import "@commontools/ui";
import { Outlet, useParams } from "react-router-dom";
import { type CharmRouteParams } from "@/routes.ts";
import ShellHeader from "@/components/ShellHeader.tsx";
import { CharmsManagerProvider } from "@/contexts/CharmManagerContext.tsx";
import { CommandCenter } from "@/components/CommandCenter.tsx";
import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import { AuthenticationView } from "@/views/AuthenticationView.tsx";
import { ActionBar } from "@/components/ActionBar.tsx";
import { CharmPublisher } from "@/components/Publish.tsx";
import { useGlobalActions } from "@/hooks/use-global-actions.tsx";
import { SyncStatusProvider } from "@/contexts/SyncStatusContext.tsx";
import * as Process from "@/components/View.tsx";

function* subscribe() {
  const test = yield* Process.wait(Promise.resolve(1));

  yield* Process.send("inc");
}

function* test() {
  yield* Process.send("inc");

  return { count: 0 };
}

const Counter = Process.service({
  *init() {
    yield* Process.spawn(function* () {
      // while (true) {
      yield* Process.sleep(1000);
      yield* Process.send("inc");
      // }
    });

    return { count: 0 };
  },

  *update({ count }, command: "inc" | "dec") {
    switch (command) {
      case "inc":
        return { count: count + 1 };
      case "dec":
        return { count: count + 1 };
      default:
        return { count };
    }
  },
});

const CounterView = Counter.View((state, controller) => (
  <button onClick={controller.dispatch("inc")}>{state.count}</button>
));

const CounterView2 = Counter.View((state, controller) => (
  <h1 onClick={controller.dispatch("inc")}>{state.count}</h1>
));

export default function Shell() {
  const { charmId } = useParams<CharmRouteParams>();
  useGlobalActions();
  const { session } = useAuthentication();

  if (!session) {
    return <AuthenticationView />;
  }

  return (
    <CharmsManagerProvider>
      <SyncStatusProvider>
        <div className="flex flex-col shell h-full bg-gray-50 border-2 border-black">
          <ShellHeader session={session} charmId={charmId} />

          <div className="h-full overflow-y-auto">
            <Outlet />
          </div>

          <ActionBar />
          <CharmPublisher />
          <CommandCenter />
          <CounterView />
          <CounterView2 />
        </div>
      </SyncStatusProvider>
    </CharmsManagerProvider>
  );
}
