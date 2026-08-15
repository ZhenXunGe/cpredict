// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import { IMarketVaultV1 } from "../interfaces/IMarketVaultV1.sol";
import {
    Unauthorized,
    ZeroAddress,
    AlreadyConfigured,
    MarketNotRegistered,
    MarketAlreadyRegistered,
    ExposureCapExceeded,
    ExposureCapCannotDecrease
} from "../libraries/ProtocolErrors.sol";

/// @notice Conservative launch-only aggregate exposure limiter.
/// @dev It never participates in settlement, refund, or claims and can be retired forever.
contract LaunchExposureGuardV1 {
    address public immutable governance;
    address public factory;
    uint256 public exposureCap;
    uint256 public totalReportedExposure;
    bool public retired;

    mapping(address => bool) public registeredMarket;
    mapping(address => uint256) public reportedExposure;

    event FactoryConfigured(address indexed factory);
    event MarketRegistered(address indexed market);
    event ExposureReserved(
        address indexed market, uint256 amount, uint256 marketExposure, uint256 totalExposure
    );
    event ExposureSynced(
        address indexed market,
        uint256 previousExposure,
        uint256 currentExposure,
        uint256 totalExposure
    );
    event ExposureCapRaised(uint256 previousCap, uint256 newCap);
    event GuardRetired(uint256 finalReportedExposure);

    constructor(address governance_, uint256 initialCap) {
        if (governance_ == address(0)) revert ZeroAddress();
        if (initialCap == 0) revert ExposureCapExceeded(1, 0);
        governance = governance_;
        exposureCap = initialCap;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized(msg.sender);
        _;
    }

    function setFactory(address factory_) external onlyGovernance {
        if (factory_ == address(0)) revert ZeroAddress();
        if (factory != address(0)) revert AlreadyConfigured();
        factory = factory_;
        emit FactoryConfigured(factory_);
    }

    function registerMarket(address market) external {
        if (msg.sender != factory) revert Unauthorized(msg.sender);
        if (market == address(0)) revert ZeroAddress();
        if (registeredMarket[market]) revert MarketAlreadyRegistered(market);
        registeredMarket[market] = true;
        emit MarketRegistered(market);
    }

    function reserve(uint256 amount) external {
        if (!registeredMarket[msg.sender]) revert MarketNotRegistered(msg.sender);
        if (retired) return;
        uint256 available =
            totalReportedExposure >= exposureCap ? 0 : exposureCap - totalReportedExposure;
        if (amount > available) revert ExposureCapExceeded(amount, available);
        uint256 nextTotal = totalReportedExposure + amount;
        uint256 nextMarket = reportedExposure[msg.sender] + amount;
        reportedExposure[msg.sender] = nextMarket;
        totalReportedExposure = nextTotal;
        emit ExposureReserved(msg.sender, amount, nextMarket, nextTotal);
    }

    function sync(address market)
        external
        returns (uint256 previousExposure, uint256 currentExposure)
    {
        if (!registeredMarket[market]) revert MarketNotRegistered(market);
        if (retired) return (reportedExposure[market], reportedExposure[market]);
        previousExposure = reportedExposure[market];
        currentExposure = IMarketVaultV1(market).guardExposure();
        reportedExposure[market] = currentExposure;
        totalReportedExposure = totalReportedExposure - previousExposure + currentExposure;
        emit ExposureSynced(market, previousExposure, currentExposure, totalReportedExposure);
    }

    function raiseCap(uint256 newCap) external onlyGovernance {
        if (newCap < exposureCap || newCap < totalReportedExposure) {
            revert ExposureCapCannotDecrease(exposureCap, newCap);
        }
        uint256 previous = exposureCap;
        exposureCap = newCap;
        emit ExposureCapRaised(previous, newCap);
    }

    function retireForever() external onlyGovernance {
        if (retired) revert AlreadyConfigured();
        retired = true;
        emit GuardRetired(totalReportedExposure);
    }
}
