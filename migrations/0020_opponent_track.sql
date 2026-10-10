-- The opponent's timeline in a fight (migration 0020), recorded by the mod's GearTracker: JSON text { d: closest distance, pre: ms of data
-- from before the fight, t0: PvP type at the start, types: [[ms from fight start, type]...], swaps: [[ms, "J>W"]...] (J jetpack,
-- W wingsuit, N neither), ms: { type: ms spent }, near: [[name, type, closest distance]...] the others within 40 blocks }.
ALTER TABLE fights ADD COLUMN opponent_track TEXT;
