import { materialPolicy } from '../../config/material-policy.js';
import { developmentTimeoutPolicy } from '../development/v2/model-diagnostic.js';
import { WRITING_MODEL_SETTINGS } from './product-generation.js';
import { PRODUCT_MAX_STEPS } from '../mastra/skills.js';
import { resolveModelId, type PracticeConfig } from '../mastra/config.js';
import { readTeamSettings } from '../mastra/team-settings.js';

/** 聚合白名单配置；仅返回安全值，不读取凭据或方法正文。 */
export function teamConfigurationView(config: PracticeConfig) {
  const settings = readTeamSettings(config);
  const timeout = developmentTimeoutPolicy('architect');
  return {
    version: 'team-configuration-view.v1' as const,
    settings,
    models: { active: { default: config.modelId, product: config.roleModels?.product ?? null, development: config.roleModels?.development ?? null, testing: config.roleModels?.testing ?? config.modelId }, pending: settings.models ? { ...settings.models, product: settings.models.product ?? settings.models.default, development: settings.models.development ?? settings.models.default, testing: settings.models.testing ?? settings.models.default } : { default: config.modelId, product: config.roleModels?.product ?? config.modelId, development: config.roleModels?.development ?? config.modelId, testing: config.roleModels?.testing ?? config.modelId }, mode: config.mode },
    teams: [
      { id: 'product', name: '产品团队', model: resolveModelId(config, 'product'), details: [
        { label: '产品写作时限', value: `${WRITING_MODEL_SETTINGS.timeout.totalMs / 60000} 分钟总计 / ${WRITING_MODEL_SETTINGS.timeout.stepMs / 60000} 分钟每步`, source: '产品生成代码' },
        { label: '产品写作输出上限', value: `${WRITING_MODEL_SETTINGS.maxOutputTokens} tokens`, source: '产品生成代码' },
        { label: '产品复合任务步数', value: `${PRODUCT_MAX_STEPS} 步`, source: '产品执行代码' },
      ] },
      { id: 'development', name: '研发团队', model: resolveModelId(config, 'development'), details: [
        { label: '研发模型时限', value: `${timeout.totalMs / 60000} 分钟总计 / ${timeout.stepMs / 60000} 分钟每步`, source: '研发超时策略' },
        { label: '技术接续默认次数', value: `${settings.developmentContinuationLimit} 次`, source: '团队设置或环境默认值' },
      ] },
      { id: 'testing', name: '测试团队', model: resolveModelId(config, 'testing'), details: [] },
      { id: 'delivery', name: '交付团队', model: null, details: [] },
    ],
    shared: [{ label: '资料读取分片', value: `${materialPolicy.chunks.chars} 字符 / 片，${materialPolicy.chunks.pageSize} 片 / 页`, source: '构建时资料读取策略' }],
    methods: config.nacosResources ? '已启用 Nacos；新 live Run 冻结方法目录，历史 Run 按原快照恢复。' : '未启用 Nacos；使用现有本地兼容路径。',
  };
}
