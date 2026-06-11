import { spawn } from "node:child_process";

const processes = [
    spawn("tsx", ["watch", "src/server.ts"], {
        stdio: "inherit",
        shell: true,
    }),
    spawn("npm", ["--prefix", "frontend", "run", "dev"], {
        stdio: "inherit",
        shell: process.platform === "win32",
    }),
];

let shuttingDown = false;

function shutdown(exitCode = 0): void {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    for (const child of processes) {
        child.kill();
    }
    process.exitCode = exitCode;
}

for (const child of processes) {
    child.on("exit", (code) => {
        if (!shuttingDown && code !== null && code !== 0) {
            shutdown(code);
        }
    });
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());
