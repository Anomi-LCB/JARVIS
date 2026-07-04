export class GrowthMemory {
  constructor(seedMemories = []) {
    this.memories = [...seedMemories];
  }

  remember(entry) {
    const memory = {
      ...entry,
      weight: entry.weight ?? 1,
      createdAt: entry.createdAt ?? new Date().toISOString()
    };
    this.memories.push(memory);
    return memory;
  }

  recallByTag(tag, limit = 5) {
    return this.memories
      .filter((memory) => memory.tags?.includes(tag))
      .sort((a, b) => b.weight - a.weight || b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  summarizeProfile() {
    const tagCounts = new Map();
    for (const memory of this.memories) {
      for (const tag of memory.tags ?? []) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + memory.weight);
      }
    }
    return [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag, score]) => ({ tag, score }));
  }
}
