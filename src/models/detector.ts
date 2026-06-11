import { Relay, RelayType } from "./relay";

export type DetectionPointState = "FAILED" | "NORMAL";

export class DetectionPoint {
    public state: DetectionPointState;
    public enteredAxleCount = 0;
    public exitedAxleCount = 0;
    public readonly rstr: Relay;
    public readonly pr: Relay;
    public readonly acpr: Relay;

    constructor(
        public readonly name: string,
        initialState: DetectionPointState = "FAILED",
    ) {
        this.state = initialState;
        this.rstr = new Relay(`${name}-RSTR`, "RSTR");
        this.pr = new Relay(`${name}-PR`, "PR");
        this.acpr = new Relay(`${name}-ACPR`, "ACPR");
    }

    public beginCounting(axleCount: number): void {
        this.enteredAxleCount = axleCount;
        this.exitedAxleCount = 0;
    }

    public countEnteringAxles(axleCount: number): void {
        this.enteredAxleCount += axleCount;
    }

    public countExitingAxles(axleCount: number): void {
        this.exitedAxleCount += axleCount;
    }

    public hasBalancedCount(): boolean {
        return (
            this.enteredAxleCount > 0 &&
            this.enteredAxleCount === this.exitedAxleCount
        );
    }

    public resetCounts(): void {
        this.enteredAxleCount = 0;
        this.exitedAxleCount = 0;
    }

    public getRelay(type: RelayType): Relay {
        switch (type) {
            case "RSTR":
                return this.rstr;
            case "PR":
                return this.pr;
            case "ACPR":
                return this.acpr;
        }
    }
}
