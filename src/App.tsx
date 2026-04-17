import { ConnectionForm } from "@/components/ConnectionForm";

function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6 text-foreground">
      <div className="flex flex-col items-center gap-1">
        <h1 className="text-2xl font-semibold">Porpoise</h1>
        <p className="text-muted-foreground text-sm">A lightweight MySQL GUI client.</p>
      </div>
      <ConnectionForm />
    </main>
  );
}

export default App;
