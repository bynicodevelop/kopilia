import { Module } from "@nestjs/common";
import { ConfigService } from "./config/config.service.js";
import { AppLogger } from "./common/logger.js";
import { DatabaseService } from "./db/database.service.js";
import { ProjectService } from "./session/project.service.js";
import { SessionService } from "./session/session.service.js";
import { MemoryService } from "./memory/memory.service.js";
import { JobService } from "./jobs/job.service.js";
import { SttService } from "./voice/stt.service.js";
import { TtsService } from "./voice/tts.service.js";
import { GatewayService } from "./gateway/gateway.service.js";
import { BootstrapController } from "./http/bootstrap.controller.js";
import { ControlController } from "./mcp/control.controller.js";
import { BriefService } from "./veille/brief.service.js";
import { BriefController } from "./veille/brief.controller.js";
import { CalendarService } from "./calendar/calendar.service.js";
import { NewsService } from "./news/news.service.js";
import { NewsController, NewsScreenController } from "./news/news.controller.js";
import { DocumentService } from "./documents/document.service.js";
import { DocumentController } from "./documents/document.controller.js";
import { MarketService } from "./market/market.service.js";
import { SkillService } from "./learning/skill.service.js";
import { ConversationService } from "./learning/conversation.service.js";
import { LearningService } from "./learning/learning.service.js";
import { LearningController } from "./learning/learning.controller.js";
import { DashboardService } from "./dashboard/dashboard.service.js";
import { DrawingService } from "./dashboard/drawing.service.js";
import { DashboardController } from "./dashboard/dashboard.controller.js";
import { AlertService } from "./alerts/alert.service.js";
import { DesktopNotifier } from "./alerts/desktop-notifier.js";
import { TelegramChannel } from "./channels/telegram.js";
import { XComposer } from "./channels/x-compose.js";
import { ChartImageService } from "./channels/chart-image.service.js";
import { AwayNotifier } from "./channels/away-notifier.js";
import { ChannelsController } from "./channels/channels.controller.js";
import { ScenarioService } from "./setups/scenario.service.js";
import { SetupAgentsService } from "./setups/setup-agents.service.js";
import { MapService } from "./setups/map.service.js";
import { LevelService } from "./setups/level.service.js";
import { ExampleService } from "./setups/example.service.js";
import { ViewsControlController, ViewsScreenController } from "./views/views.controller.js";
import { SetupsUpdatedView } from "./setups/setups-view.js";
import { SetupsController } from "./setups/setups.controller.js";
import { AnalysisService } from "./analyses/analysis.service.js";
import { AnalysesController } from "./analyses/analyses.controller.js";
import { SetupsScreenController } from "./setups/setups-screen.controller.js";
import { TradingService } from "./trading/trading.service.js";
import { TradingControlController, TradingScreenController } from "./trading/trading.controller.js";
import { BrokerPauseService } from "./market/broker-pause.service.js";
import { BrokerControlController, BrokerScreenController } from "./market/broker.controller.js";
import { JournalService } from "./journal/journal.service.js";
import { JournalControlController, JournalScreenController } from "./journal/journal.controller.js";
import { CandleStore } from "./algo/candle-store.js";
import { CandleLoaderService } from "./algo/candle-loader.service.js";
import { RobotService } from "./algo/robot.service.js";
import { BacktestService } from "./algo/backtest.service.js";
import { AlgoAgentsService } from "./algo/algo-agents.service.js";
import { AlgoController } from "./algo/algo.controller.js";

@Module({
  controllers: [
    BootstrapController,
    ControlController,
    BriefController,
    DocumentController,
    LearningController,
    DashboardController,
    SetupsController,
    AnalysesController,
    SetupsScreenController,
    ViewsScreenController,
    ViewsControlController,
    ChannelsController,
    NewsController,
    NewsScreenController,
    TradingScreenController,
    TradingControlController,
    BrokerScreenController,
    BrokerControlController,
    JournalScreenController,
    JournalControlController,
    AlgoController,
  ],
  providers: [
    ConfigService,
    AppLogger,
    DatabaseService,
    ProjectService,
    SessionService,
    MemoryService,
    SkillService,
    ConversationService,
    CalendarService,
    MarketService,
    NewsService,
    DrawingService,
    AlertService,
    DesktopNotifier,
    DashboardService,
    TelegramChannel,
    XComposer,
    ChartImageService,
    AwayNotifier,
    ScenarioService,
    AnalysisService,
    MapService,
    LevelService,
    ExampleService,
    SetupsUpdatedView,
    TradingService,
    BrokerPauseService,
    JournalService,
    CandleStore,
    CandleLoaderService,
    RobotService,
    BacktestService,
    AlgoAgentsService,
    DocumentService,
    JobService,
    BriefService,
    LearningService,
    SetupAgentsService,
    SttService,
    TtsService,
    GatewayService,
  ],
})
export class AppModule {}
