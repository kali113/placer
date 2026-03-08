// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SomniaPlace {
    error NotOwner();
    error NotReactor();
    error InvalidBounds();
    error InvalidPaletteIndex();
    error InvalidConfiguration();
    error CooldownActive(uint64 nextEligibleTime);

    event PixelPlaced(
        address indexed placer,
        uint16 x,
        uint16 y,
        uint8 color,
        uint256 timestamp
    );
    event ReactorUpdated(address indexed reactor);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PenaltyCooldownSet(address indexed user, uint64 indexed until);
    event PixelDecayed(uint16 indexed x, uint16 indexed y, uint8 color, uint256 timestamp);

    uint16 public immutable WIDTH;
    uint16 public immutable HEIGHT;
    uint8 public immutable PALETTE_SIZE;
    uint64 public constant BASE_COOLDOWN = 30;

    uint256 private constant COLOR_MASK = type(uint8).max;
    uint256 private constant OWNER_OFFSET = 8;
    uint256 private constant LAST_UPDATED_OFFSET = 168;
    uint256 private constant OVERWRITE_COUNT_OFFSET = 232;
    uint256 private constant FLAGS_OFFSET = 248;

    address public owner;
    address public reactor;

    mapping(uint32 => uint256) private pixelData;
    mapping(address => uint64) public lastPlacementAt;
    mapping(address => uint64) public penaltyCooldownUntil;
    mapping(address => uint256) public userPixelsPlaced;
    uint256 public totalPixelsPlaced;

    mapping(address => bool) private participantSeen;
    address[] private participants;

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner();
        }
        _;
    }

    modifier onlyReactor() {
        if (msg.sender != reactor) {
            revert NotReactor();
        }
        _;
    }

    constructor(uint16 width_, uint16 height_, uint8 paletteSize_) {
        if (width_ == 0 || height_ == 0 || paletteSize_ == 0 || width_ > 256 || height_ > 256) {
            revert InvalidConfiguration();
        }

        WIDTH = width_;
        HEIGHT = height_;
        PALETTE_SIZE = paletteSize_;
        owner = msg.sender;

        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert InvalidConfiguration();
        }

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setReactor(address newReactor) external onlyOwner {
        reactor = newReactor;
        emit ReactorUpdated(newReactor);
    }

    function placePixel(uint16 x, uint16 y, uint8 color) external {
        _validateCoordinates(x, y);

        if (color >= PALETTE_SIZE) {
            revert InvalidPaletteIndex();
        }

        uint64 nextEligible = nextEligibleTime(msg.sender);
        if (uint64(block.timestamp) < nextEligible) {
            revert CooldownActive(nextEligible);
        }

        uint32 pixelId = _pixelId(x, y);
        uint256 existing = pixelData[pixelId];
        uint16 overwriteCount = _overwriteCount(existing);

        if (_owner(existing) != address(0)) {
            unchecked {
                overwriteCount += 1;
            }
        }

        pixelData[pixelId] = _packPixel(color, msg.sender, uint64(block.timestamp), overwriteCount, 0);
        lastPlacementAt[msg.sender] = uint64(block.timestamp);

        unchecked {
            totalPixelsPlaced += 1;
            userPixelsPlaced[msg.sender] += 1;
        }

        if (!participantSeen[msg.sender]) {
            participantSeen[msg.sender] = true;
            participants.push(msg.sender);
        }

        emit PixelPlaced(msg.sender, x, y, color, block.timestamp);
    }

    function setPenaltyCooldown(address user, uint64 until) external onlyReactor {
        penaltyCooldownUntil[user] = until;
        emit PenaltyCooldownSet(user, until);
    }

    function decayPixel(uint16 x, uint16 y, uint8 newColor) external onlyReactor {
        _validateCoordinates(x, y);

        if (newColor >= PALETTE_SIZE) {
            revert InvalidPaletteIndex();
        }

        uint32 pixelId = _pixelId(x, y);
        uint256 existing = pixelData[pixelId];
        uint16 overwriteCount = _overwriteCount(existing);
        uint8 flags = _flags(existing);

        pixelData[pixelId] = _packPixel(newColor, address(0), uint64(block.timestamp), overwriteCount, flags);

        emit PixelDecayed(x, y, newColor, block.timestamp);
    }

    function getCanvas() external view returns (bytes memory canvas) {
        uint256 total = uint256(WIDTH) * uint256(HEIGHT);
        canvas = new bytes(total);

        for (uint32 i = 0; i < total; ++i) {
            canvas[i] = bytes1(uint8(pixelData[i] & COLOR_MASK));
        }
    }

    function getRegion(
        uint16 startX,
        uint16 startY,
        uint16 width_,
        uint16 height_
    ) external view returns (bytes memory region) {
        if (
            startX >= WIDTH ||
            startY >= HEIGHT ||
            uint256(startX) + uint256(width_) > WIDTH ||
            uint256(startY) + uint256(height_) > HEIGHT
        ) {
            revert InvalidBounds();
        }

        uint256 total = uint256(width_) * uint256(height_);
        region = new bytes(total);
        uint256 offset;

        for (uint16 y = startY; y < startY + height_; ++y) {
            for (uint16 x = startX; x < startX + width_; ++x) {
                region[offset] = bytes1(uint8(pixelData[_pixelId(x, y)] & COLOR_MASK));
                unchecked {
                    offset += 1;
                }
            }
        }
    }

    function getPixelPacked(uint16 x, uint16 y) external view returns (uint256) {
        _validateCoordinates(x, y);
        return pixelData[_pixelId(x, y)];
    }

    function getUserStats(
        address user
    ) external view returns (uint256 placedCount, uint64 nextEligible) {
        return (userPixelsPlaced[user], nextEligibleTime(user));
    }

    function nextEligibleTime(address user) public view returns (uint64) {
        uint64 standardCooldown = lastPlacementAt[user] + BASE_COOLDOWN;
        uint64 penalizedCooldown = penaltyCooldownUntil[user];
        return standardCooldown > penalizedCooldown ? standardCooldown : penalizedCooldown;
    }

    function getParticipants(
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory slice) {
        uint256 total = participants.length;
        if (offset >= total || limit == 0) {
            return new address[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        slice = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            slice[i - offset] = participants[i];
        }
    }

    function participantCount() external view returns (uint256) {
        return participants.length;
    }

    function _validateCoordinates(uint16 x, uint16 y) internal view {
        if (x >= WIDTH || y >= HEIGHT) {
            revert InvalidBounds();
        }
    }

    function _pixelId(uint16 x, uint16 y) internal view returns (uint32) {
        return (uint32(y) * uint32(WIDTH)) + uint32(x);
    }

    function _packPixel(
        uint8 color,
        address owner_,
        uint64 lastUpdated,
        uint16 overwriteCount,
        uint8 flags
    ) internal pure returns (uint256 packed) {
        packed =
            uint256(color) |
            (uint256(uint160(owner_)) << OWNER_OFFSET) |
            (uint256(lastUpdated) << LAST_UPDATED_OFFSET) |
            (uint256(overwriteCount) << OVERWRITE_COUNT_OFFSET) |
            (uint256(flags) << FLAGS_OFFSET);
    }

    function _owner(uint256 packed) internal pure returns (address) {
        return address(uint160(packed >> OWNER_OFFSET));
    }

    function _overwriteCount(uint256 packed) internal pure returns (uint16) {
        return uint16(packed >> OVERWRITE_COUNT_OFFSET);
    }

    function _flags(uint256 packed) internal pure returns (uint8) {
        return uint8(packed >> FLAGS_OFFSET);
    }
}
