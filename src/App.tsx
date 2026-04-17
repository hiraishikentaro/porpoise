import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";

function App() {
  const [greeting, setGreeting] = useState<string>("");

  async function handleGreet() {
    const message = await invoke<string>("greet", { name: "Porpoise" });
    setGreeting(message);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background text-foreground">
      <h1 className="text-2xl font-semibold">Porpoise</h1>
      <p className="text-muted-foreground text-sm">A lightweight MySQL GUI client.</p>
      <Button onClick={handleGreet}>Say hello</Button>
      {greeting && <p className="text-sm">{greeting}</p>}
    </main>
  );
}

export default App;
