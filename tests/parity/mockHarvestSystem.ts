/**
 * Shared MockHarvestSystem for parity tests that need ProductionSystem.
 */
export class MockHarvestSystem {
  private solaris = new Map<number, number>();

  getSolaris(playerId: number): number {
    return this.solaris.get(playerId) ?? 0;
  }

  addSolaris(playerId: number, amount: number): void {
    this.solaris.set(playerId, (this.solaris.get(playerId) ?? 0) + amount);
  }

  spendSolaris(playerId: number, amount: number): boolean {
    const current = this.solaris.get(playerId) ?? 0;
    if (current < amount) return false;
    this.solaris.set(playerId, current - amount);
    return true;
  }
}
