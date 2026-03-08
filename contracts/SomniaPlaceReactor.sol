// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SomniaEventHandler } from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";

interface ISomniaPlaceCanvas {
    function WIDTH() external view returns (uint16);
    function HEIGHT() external view returns (uint16);
    function getPixelPacked(uint16 x, uint16 y) external view returns (uint256);
    function setPenaltyCooldown(address user, uint64 until) external;
    function decayPixel(uint16 x, uint16 y, uint8 newColor) external;
}

contract SomniaPlaceReactor is SomniaEventHandler {
    error InvalidCanvas();
    error InvalidEmitter(address emitter);
    error InvalidTopic(bytes32 topic);
    error MissingIndexedTopic();

    event TerritoryScored(
        address indexed player,
        uint32 indexed pixelId,
        uint256 clusterSize,
        uint256 pointsAwarded,
        uint256 totalScore
    );
    event CooldownPenaltyApplied(
        address indexed player,
        uint32 indexed pixelId,
        uint64 penaltyUntil,
        uint256 overwriteStreak
    );
    event PatternRewarded(
        address indexed player,
        bytes32 indexed pattern,
        uint32 indexed pixelId,
        uint256 pointsAwarded,
        uint256 totalScore
    );
    event PixelDecayed(uint16 indexed x, uint16 indexed y, uint8 newColor, uint256 timestamp);

    bytes32 public constant PIXEL_PLACED_TOPIC =
        keccak256("PixelPlaced(address,uint16,uint16,uint8,uint256)");
    bytes32 public constant BLOCK_2X2_PATTERN = keccak256("BLOCK_2X2");
    bytes32 public constant HORIZONTAL_4_PATTERN = keccak256("HORIZONTAL_4");
    bytes32 public constant VERTICAL_4_PATTERN = keccak256("VERTICAL_4");

    uint8 private constant NEUTRAL_COLOR = 0;
    uint64 private constant PENALTY_SECONDS = 120;
    uint64 private constant DECAY_THRESHOLD_SECONDS = 1800;
    uint64 private constant OVERWRITE_BLOCK_WINDOW = 25;
    uint16 private constant OVERWRITE_STREAK_THRESHOLD = 3;
    uint8 private constant CLUSTER_RADIUS = 2;

    uint256 private constant COLOR_MASK = type(uint8).max;
    uint256 private constant LAST_UPDATED_OFFSET = 168;

    ISomniaPlaceCanvas public immutable canvas;
    uint16 public immutable width;
    uint16 public immutable height;

    mapping(address => uint256) public scores;
    mapping(uint32 => uint64) public lastOverwriteBlock;
    mapping(uint32 => uint16) public overwriteStreak;

    mapping(address => bool) private playerSeen;
    address[] private players;

    constructor(address canvasAddress) {
        if (canvasAddress == address(0)) {
            revert InvalidCanvas();
        }

        canvas = ISomniaPlaceCanvas(canvasAddress);
        width = canvas.WIDTH();
        height = canvas.HEIGHT();
    }

    function getTopPlayers(
        uint256 limit
    ) external view returns (address[] memory topPlayers, uint256[] memory topScores) {
        uint256 totalPlayers = players.length;
        if (limit == 0 || totalPlayers == 0) {
            return (new address[](0), new uint256[](0));
        }

        if (limit > totalPlayers) {
            limit = totalPlayers;
        }

        topPlayers = new address[](limit);
        topScores = new uint256[](limit);
        bool[] memory used = new bool[](totalPlayers);

        for (uint256 slot = 0; slot < limit; ++slot) {
            uint256 bestIndex = type(uint256).max;
            uint256 bestScore;

            for (uint256 i = 0; i < totalPlayers; ++i) {
                if (used[i]) {
                    continue;
                }

                uint256 score = scores[players[i]];
                if (bestIndex == type(uint256).max || score > bestScore) {
                    bestIndex = i;
                    bestScore = score;
                }
            }

            used[bestIndex] = true;
            topPlayers[slot] = players[bestIndex];
            topScores[slot] = bestScore;
        }
    }

    function playerCount() external view returns (uint256) {
        return players.length;
    }

    function _onEvent(
        address emitter,
        bytes32[] calldata eventTopics,
        bytes calldata data
    ) internal override {
        if (emitter != address(canvas)) {
            revert InvalidEmitter(emitter);
        }
        if (eventTopics.length == 0 || eventTopics[0] != PIXEL_PLACED_TOPIC) {
            revert InvalidTopic(eventTopics.length == 0 ? bytes32(0) : eventTopics[0]);
        }
        if (eventTopics.length < 2) {
            revert MissingIndexedTopic();
        }

        address placer = address(uint160(uint256(eventTopics[1])));
        (uint16 x, uint16 y, uint8 color, uint256 timestamp) = abi.decode(
            data,
            (uint16, uint16, uint8, uint256)
        );

        _trackPlayer(placer);
        _applyTerritoryScore(placer, x, y, color);
        _applyPatternRewards(placer, x, y, color);
        _applyAntiGriefing(placer, x, y);
        _applyDecaySweep(x, y, uint64(timestamp));
    }

    function _applyTerritoryScore(address placer, uint16 x, uint16 y, uint8 color) internal {
        uint256 clusterSize = _estimateClusterSize(x, y, color);
        if (clusterSize < 3) {
            return;
        }

        uint256 pointsAwarded = clusterSize * 2;
        uint256 totalScore = _awardPoints(placer, pointsAwarded);

        emit TerritoryScored(placer, _pixelId(x, y), clusterSize, pointsAwarded, totalScore);
    }

    function _applyPatternRewards(address placer, uint16 x, uint16 y, uint8 color) internal {
        if (_hasBlockPattern(x, y, color)) {
            uint256 blockScore = _awardPoints(placer, 8);
            emit PatternRewarded(
                placer,
                BLOCK_2X2_PATTERN,
                _pixelId(x, y),
                8,
                blockScore
            );
        }

        if (_hasHorizontalFour(x, y, color)) {
            uint256 horizontalScore = _awardPoints(placer, 6);
            emit PatternRewarded(
                placer,
                HORIZONTAL_4_PATTERN,
                _pixelId(x, y),
                6,
                horizontalScore
            );
        }

        if (_hasVerticalFour(x, y, color)) {
            uint256 verticalScore = _awardPoints(placer, 6);
            emit PatternRewarded(
                placer,
                VERTICAL_4_PATTERN,
                _pixelId(x, y),
                6,
                verticalScore
            );
        }
    }

    function _applyAntiGriefing(address placer, uint16 x, uint16 y) internal {
        uint32 pixelId = _pixelId(x, y);
        uint64 previousBlock = lastOverwriteBlock[pixelId];

        if (previousBlock != 0 && block.number <= previousBlock + OVERWRITE_BLOCK_WINDOW) {
            unchecked {
                overwriteStreak[pixelId] += 1;
            }
        } else {
            overwriteStreak[pixelId] = 1;
        }

        lastOverwriteBlock[pixelId] = uint64(block.number);

        if (overwriteStreak[pixelId] < OVERWRITE_STREAK_THRESHOLD) {
            return;
        }

        uint64 penaltyUntil =
            uint64(block.timestamp) +
            PENALTY_SECONDS +
            uint64(overwriteStreak[pixelId] - OVERWRITE_STREAK_THRESHOLD) *
            30;

        canvas.setPenaltyCooldown(placer, penaltyUntil);
        emit CooldownPenaltyApplied(placer, pixelId, penaltyUntil, overwriteStreak[pixelId]);
    }

    function _applyDecaySweep(uint16 x, uint16 y, uint64 placedAt) internal {
        uint256 decayed;

        if (x > 0 && _tryDecayPixel(x - 1, y, placedAt)) {
            unchecked {
                decayed += 1;
            }
        }
        if (x + 1 < width && decayed < 2 && _tryDecayPixel(x + 1, y, placedAt)) {
            unchecked {
                decayed += 1;
            }
        }
        if (y > 0 && decayed < 2 && _tryDecayPixel(x, y - 1, placedAt)) {
            unchecked {
                decayed += 1;
            }
        }
        if (y + 1 < height && decayed < 2 && _tryDecayPixel(x, y + 1, placedAt)) {
            unchecked {
                decayed += 1;
            }
        }
    }

    function _tryDecayPixel(uint16 x, uint16 y, uint64 placedAt) internal returns (bool) {
        uint256 packed = canvas.getPixelPacked(x, y);
        uint8 color = uint8(packed & COLOR_MASK);
        if (color == NEUTRAL_COLOR) {
            return false;
        }

        uint64 lastUpdated = uint64(packed >> LAST_UPDATED_OFFSET);
        if (placedAt <= lastUpdated || placedAt - lastUpdated < DECAY_THRESHOLD_SECONDS) {
            return false;
        }

        canvas.decayPixel(x, y, NEUTRAL_COLOR);
        emit PixelDecayed(x, y, NEUTRAL_COLOR, block.timestamp);
        return true;
    }

    function _estimateClusterSize(uint16 x, uint16 y, uint8 color) internal view returns (uint256) {
        uint16 minX = x > CLUSTER_RADIUS ? x - CLUSTER_RADIUS : 0;
        uint16 minY = y > CLUSTER_RADIUS ? y - CLUSTER_RADIUS : 0;
        uint16 maxX = x + CLUSTER_RADIUS < width ? x + CLUSTER_RADIUS : width - 1;
        uint16 maxY = y + CLUSTER_RADIUS < height ? y + CLUSTER_RADIUS : height - 1;

        uint16[25] memory xs;
        uint16[25] memory ys;
        bool[25] memory sameColor;
        bool[25] memory visited;
        uint16[25] memory queue;

        uint16 cellCount;
        uint16 startIndex;
        bool foundStart;

        for (uint16 yy = minY; yy <= maxY; ++yy) {
            for (uint16 xx = minX; xx <= maxX; ++xx) {
                xs[cellCount] = xx;
                ys[cellCount] = yy;

                if (_colorAt(xx, yy) == color) {
                    sameColor[cellCount] = true;
                    if (xx == x && yy == y) {
                        startIndex = cellCount;
                        foundStart = true;
                    }
                }

                unchecked {
                    cellCount += 1;
                }
            }
        }

        if (!foundStart) {
            return 0;
        }

        uint16 head;
        uint16 tail = 1;
        queue[0] = startIndex;
        visited[startIndex] = true;

        uint256 count;
        while (head < tail) {
            uint16 current = queue[head];
            unchecked {
                head += 1;
                count += 1;
            }

            for (uint16 i = 0; i < cellCount; ++i) {
                if (!sameColor[i] || visited[i]) {
                    continue;
                }

                if (_isOrthogonalNeighbor(xs[current], ys[current], xs[i], ys[i])) {
                    visited[i] = true;
                    queue[tail] = i;
                    unchecked {
                        tail += 1;
                    }
                }
            }
        }

        return count;
    }

    function _hasBlockPattern(uint16 x, uint16 y, uint8 color) internal view returns (bool) {
        if (x > 0 && y > 0 && _squareMatches(x - 1, y - 1, color)) {
            return true;
        }
        if (y > 0 && x + 1 < width && _squareMatches(x, y - 1, color)) {
            return true;
        }
        if (x > 0 && y + 1 < height && _squareMatches(x - 1, y, color)) {
            return true;
        }
        if (x + 1 < width && y + 1 < height && _squareMatches(x, y, color)) {
            return true;
        }
        return false;
    }

    function _hasHorizontalFour(uint16 x, uint16 y, uint8 color) internal view returns (bool) {
        for (uint8 offset = 0; offset < 4; ++offset) {
            if (x < offset) {
                continue;
            }

            uint16 startX = x - offset;
            if (startX + 3 >= width) {
                continue;
            }

            bool matches = true;
            for (uint16 i = 0; i < 4; ++i) {
                if (_colorAt(startX + i, y) != color) {
                    matches = false;
                    break;
                }
            }

            if (matches) {
                return true;
            }
        }

        return false;
    }

    function _hasVerticalFour(uint16 x, uint16 y, uint8 color) internal view returns (bool) {
        for (uint8 offset = 0; offset < 4; ++offset) {
            if (y < offset) {
                continue;
            }

            uint16 startY = y - offset;
            if (startY + 3 >= height) {
                continue;
            }

            bool matches = true;
            for (uint16 i = 0; i < 4; ++i) {
                if (_colorAt(x, startY + i) != color) {
                    matches = false;
                    break;
                }
            }

            if (matches) {
                return true;
            }
        }

        return false;
    }

    function _squareMatches(uint16 topLeftX, uint16 topLeftY, uint8 color) internal view returns (bool) {
        return
            _colorAt(topLeftX, topLeftY) == color &&
            _colorAt(topLeftX + 1, topLeftY) == color &&
            _colorAt(topLeftX, topLeftY + 1) == color &&
            _colorAt(topLeftX + 1, topLeftY + 1) == color;
    }

    function _colorAt(uint16 x, uint16 y) internal view returns (uint8) {
        return uint8(canvas.getPixelPacked(x, y) & COLOR_MASK);
    }

    function _awardPoints(address player, uint256 points) internal returns (uint256 totalScore) {
        _trackPlayer(player);
        totalScore = scores[player] + points;
        scores[player] = totalScore;
    }

    function _trackPlayer(address player) internal {
        if (!playerSeen[player]) {
            playerSeen[player] = true;
            players.push(player);
        }
    }

    function _pixelId(uint16 x, uint16 y) internal view returns (uint32) {
        return (uint32(y) * uint32(width)) + uint32(x);
    }

    function _isOrthogonalNeighbor(
        uint16 ax,
        uint16 ay,
        uint16 bx,
        uint16 by
    ) internal pure returns (bool) {
        if (ax == bx) {
            return ay + 1 == by || by + 1 == ay;
        }
        if (ay == by) {
            return ax + 1 == bx || bx + 1 == ax;
        }
        return false;
    }
}
