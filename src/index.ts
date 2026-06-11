import { SimulationEngine } from "./engine/simulationengine";

async function main(): Promise<void> {
    const engine = new SimulationEngine(2_000);

    await engine.startSystem();
    console.log("[State after startup]");
    console.dir(engine.getState(), { depth: null });

    await engine.simulateTrainPass("1T", 12);
    console.log("[State after first train clears 1T]");
    console.dir(engine.getState(), { depth: null });

    await engine.simulateTrainPass("1T", 16);
    console.log("[State after second train clears 1T]");
    console.dir(engine.getState(), { depth: null });
}

main().catch((error: unknown) => {
    console.error("[Simulation error]", error);
    process.exitCode = 1;
});
