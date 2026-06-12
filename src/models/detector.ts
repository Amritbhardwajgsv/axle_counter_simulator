import { Relay, RelayType } from "./relay";

export type DetectionPointState = "FAILED" | "NORMAL";
export type RailId = "A" | "B";

export class RailChannel {
    public failed = false;
    public readonly rstr: Relay;
    public readonly pr: Relay;
    public readonly acpr: Relay;

    constructor(
        detectionPointName: string,
        public readonly id: RailId,
    ) {
        this.rstr = new Relay(`${detectionPointName}-${id}-RSTR`, "RSTR");
        this.pr = new Relay(`${detectionPointName}-${id}-PR`, "PR");
        this.acpr = new Relay(`${detectionPointName}-${id}-ACPR`, "ACPR");
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

export class DetectionPoint {
    public state: DetectionPointState;
    public enteredAxleCount = 0;
    public exitedAxleCount = 0;
    public readonly rails: Record<RailId, RailChannel>;

    constructor(
        public readonly name: string,
        initialState: DetectionPointState = "FAILED",
    ) {
        this.state = initialState;
        this.rails = {
            A: new RailChannel(name, "A"),
            B: new RailChannel(name, "B"),
        };
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

    public getRail(railId: RailId): RailChannel {
        return this.rails[railId];
    }
}
