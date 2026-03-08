import { keccak256, parseAbi, toBytes } from "viem";

export const somniaPlaceAbi = parseAbi([
  "event PixelPlaced(address indexed placer, uint16 x, uint16 y, uint8 color, uint256 timestamp)",
  "event PixelDecayed(uint16 indexed x, uint16 indexed y, uint8 color, uint256 timestamp)",
  "event PenaltyCooldownSet(address indexed user, uint64 indexed until)",
  "function WIDTH() view returns (uint16)",
  "function HEIGHT() view returns (uint16)",
  "function PALETTE_SIZE() view returns (uint8)",
  "function getCanvas() view returns (bytes)",
  "function getPixelPacked(uint16 x, uint16 y) view returns (uint256)",
  "function getUserStats(address user) view returns (uint256 placedCount, uint64 nextEligibleTime)",
  "function placePixel(uint16 x, uint16 y, uint8 color)",
  "function participantCount() view returns (uint256)",
  "function getParticipants(uint256 offset, uint256 limit) view returns (address[] memory)"
]);

export const somniaPlaceReactorAbi = parseAbi([
  "event TerritoryScored(address indexed player, uint32 indexed pixelId, uint256 clusterSize, uint256 pointsAwarded, uint256 totalScore)",
  "event CooldownPenaltyApplied(address indexed player, uint32 indexed pixelId, uint64 penaltyUntil, uint256 overwriteStreak)",
  "event PatternRewarded(address indexed player, bytes32 indexed pattern, uint32 indexed pixelId, uint256 pointsAwarded, uint256 totalScore)",
  "event PixelDecayed(uint16 indexed x, uint16 indexed y, uint8 newColor, uint256 timestamp)",
  "function getTopPlayers(uint256 limit) view returns (address[] memory topPlayers, uint256[] memory topScores)",
  "function scores(address player) view returns (uint256)",
  "function playerCount() view returns (uint256)"
]);

export const pixelPlacedTopic = keccak256(
  toBytes("PixelPlaced(address,uint16,uint16,uint8,uint256)")
);

