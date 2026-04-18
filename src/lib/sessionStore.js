import { create } from 'zustand';

const useSessionStore = create((set, get) => ({
  sessions: [],
  activeSessionId: null,
  activeSessionMeta: null,
  packages: [],
  setSessions: (v) => set({ sessions: v }),
  setActiveSession: (id, meta) => set({ activeSessionId: id, activeSessionMeta: meta }),
  setPackages: (v) => set({ packages: v }),

  studioPrompt: '',
  batchSize: 1,
  generating: false,
  progress: 0,
  progressMax: 0,
  error: null,
  setStudioPrompt: (v) => set({ studioPrompt: v }),
  setBatchSize: (v) => set({ batchSize: v }),
  setGenerating: (v) => set({ generating: v }),
  setProgress: (v, max) => set({ progress: v, progressMax: max || 0 }),
  setError: (v) => set({ error: v }),

  // Add a new package to the list
  addPackage: (pkg) => set((s) => {
    if (s.packages.some(p => p.id === pkg.id)) return s;
    return { packages: [pkg, ...s.packages] };
  }),

  // Update a package in the list (after adding variant, video, etc.)
  updatePackage: (pkgId, updatedPkg) => set((s) => ({
    packages: s.packages.map(p => p.id === pkgId ? updatedPkg : p),
  })),

  // Remove a package
  removePackage: (pkgId) => set((s) => ({
    packages: s.packages.filter(p => p.id !== pkgId),
  })),

  showSettings: false,
  setShowSettings: (v) => set({ showSettings: v }),
}));

export default useSessionStore;
