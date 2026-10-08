import {createHash} from 'node:crypto';
export const MISSION_EGRESS_GOAL_BINDING_VERSION='mission-egress-goal-binding-v1';
const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;
// SQLite serializes object properties canonically. Bind semantic JSON values,
// including array order, rather than their in-memory insertion order.
export function missionEgressGoalBinding(mission){
  const value=JSON.parse(JSON.stringify({objective:mission.objective,goalContract:mission.goalContract}));
  return createHash('sha256').update(`${MISSION_EGRESS_GOAL_BINDING_VERSION}\n${JSON.stringify(normalize(value))}`).digest('hex');
}
