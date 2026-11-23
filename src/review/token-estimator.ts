export class TokenEstimator {
  constructor(readonly charsPerToken: number = 4) {}

  // Callers sum chars first, then estimate once: per-part ceilings would not add up to the same total.
  estimate(chars: number): number {
    return Math.ceil(chars / this.charsPerToken)
  }
}

export const defaultTokenEstimator = new TokenEstimator()
