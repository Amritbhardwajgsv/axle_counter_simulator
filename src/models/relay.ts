export type RelayType = "RSTR" | "PR" | "ACPR";
export type RelayState = "PICKED" | "DROPPED";

export class Relay {
    public state: RelayState;
    public lastChanged: Date;

    constructor(
        public readonly id: string,
        public readonly type: RelayType,
        initialState: RelayState = "DROPPED",
    ) {
        this.state = initialState;
        this.lastChanged = new Date();
    }

    public setState(state: RelayState): boolean {
        if (this.state === state) {
            return false;
        }

        this.state = state;
        this.lastChanged = new Date();
        return true;
    }
}
