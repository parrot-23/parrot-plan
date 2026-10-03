// 中文文案
export const zh = {
    // 通用
    'common.cancel': '取消',
    'common.confirm': '确认',
    'common.save': '保存',
    'common.delete': '删除',
    'common.select': '选择',
    'common.clear': '清除',
    'common.add': '添加',
    'common.apply': '应用',

    // 星期
    'week.monday': '周一',
    'week.tuesday': '周二',
    'week.wednesday': '周三',
    'week.thursday': '周四',
    'week.friday': '周五',
    'week.saturday': '周六',
    'week.sunday': '周日',

    // 视图
    'view.title': '周日程',

    // 主导航（tab 按钮组）
    'nav.year': '年',
    'nav.week': '周计划',
    'nav.today': '当日执行',
    'nav.swimlane': '泳道图',
    'nav.achievement': '成就榜单',
    'nav.placeholder': '当前是「{name}」页面',

    // 当日执行视图
    'today.start': '开始执行',
    'today.detailTitle': '任务详情',
    'today.noSelection': '选中左侧任务或时间轴上的事件以查看详情',
    'today.noDescription': '暂无描述',
    'today.category': '分类',
    'today.timeRange': '时间',
    'today.allDay': '全天',
    'today.complete': '完成执行计划任务',
    'today.replace': '替换执行其他任务',
    'today.execUnplanned': '执行非计划任务',
    'today.execPlanned': '执行计划',
    'today.replacePlanned': '替换计划',
    'today.completeDone': '已记录「{title}」的执行',
    'today.replaceNeedEvent': '请先在时间轴上选中要替换的事件',
    'today.replaceDone': '已将事件替换为「{title}」',

    // 年视图
    'year.weekLabel': '第{week}周',
    'year.monthLabel': '{month}月',
    'year.thisYear': '今年',
    'year.assigned': '已将「{title}」分配到 {week}',
    // 泳道图
    'swimlane.weekLabel': 'W{week}',
    'swimlane.legendPlan': '计划项',
    'swimlane.legendExec': '执行记录',
    'year.unassigned': '已取消「{title}」在 {week} 的分配',

    // 命令与功能区
    'command.open': '打开周日程面板',
    'ribbon.open': '打开周日程',

    // 默认分类
    'defaultCategory.work': '工作',
    'defaultCategory.rest': '休息',
    'defaultCategory.play': '娱乐',
    'defaultCategory.uncategorized': '未分类',

    // 设置页
    'settings.title': 'Parrot Plan 设置',
    'settings.about': '一个周日程规划插件：时间区块规划、事件排布与执行追踪。',
    'settings.data': '数据',
    'settings.clearData': '清空数据',
    'settings.clearDataDesc': '删除全部任务、事件、时间区间与配置，恢复为默认状态。此操作不可撤销。',
    'settings.clearDataConfirm': '确认清空数据？',
    'settings.clearDataConfirmDesc': '所有数据将被永久删除且无法恢复。',
    'settings.clearDataDone': '数据已清空',
    'settings.confirm': '确认',
    'settings.cancel': '取消',

    // 全天事件
    'allday.label': '全天',
    'allday.needSelect': '请先在收集盒中选中一个任务',
    'allday.added': '已添加全天事件"{title}"',
    'allday.empty': '暂无',

    // 事件层
    'event.scheduled': '已排入"{title}"',
    'event.alreadyScheduled': '"{title}"当天已排入，无需重复添加',
    'event.edit': '编辑事件',
    'event.create': '新建事件',
    'event.title': '标题',
    'event.titlePlaceholder': '事件名称',
    'event.startTime': '开始时间',
    'event.endTime': '结束时间',
    'event.category': '分类',
    'event.noCategory': '不分类',
    'event.titleRequired': '标题不能为空',

    // 时间区块
    'range.title': '时间区块',
    'range.startTime': '开始时间',
    'range.endTime': '结束时间',
    'range.category': '分类',

    // 时间区间设置窗口
    'rangeScheme.open': '时间区间设置',
    'rangeScheme.title': '时间区间设置',
    'rangeScheme.switch': '方案切换',
    'rangeScheme.manage': '方案管理',
    'rangeScheme.manageTitle': '方案管理',
    'rangeScheme.new': '新方案',
    'rangeScheme.defaultName': '默认方案',
    'rangeScheme.namePlaceholder': '方案名称',
    'rangeScheme.empty': '暂无方案，点右上角 + 新增',
    'rangeScheme.noActive': '未选择方案',
    'rangeScheme.switchTo': '切换',
    'rangeScheme.isDefault': '默认',
    'rangeScheme.defaultLocked': '默认方案不可删除',

    // 周切换
    'weekNav.year': '年',
    'weekNav.week': '周',
    'weekNav.thisWeek': '本周',

    // 分类
    'category.legend': '时间区块图例',
    'category.config': '分类配置',
    'category.new': '新分类',
    'category.empty': '暂无分类，点右上角 + 新增',
    'category.namePlaceholder': '分类名称',
    'category.uncategorizedLocked': '未分类不可删除',

    // 模板
    'template.title': '日模板',
    'template.selectFirst': '请先选择模板',
    'template.notFound': '模板不存在',
    'template.create': '新增日模板',
    'template.name': '模板名称',
    'template.namePlaceholder': '如：深度工作',
    'template.copyFrom': '复制自',
    'template.nameRequired': '请输入模板名称',
    'template.unnamed': '未命名模板',
    'template.applyTo': '应用「{name}」到哪些天？',
    'template.selectAll': '全选',
    'template.clearAll': '清空',
    'template.selectAtLeastOne': '请至少选择一天',
    'template.deleteTitle': '删除模板',
    'template.deleteConfirm': '确定删除模板「{name}」？\n 已应用到网格的时间区块不受影响。',

    // 收集盒
    'inbox.addTitle': '添加到收集盒',
    'inbox.addSubTitle': '添加子任务到「{title}」',
    'inbox.name': '名称',
    'inbox.namePlaceholder': '一句话概括',
    'inbox.desc': '描述',
    'inbox.descPlaceholder': '补充说明（可选）',
    'inbox.nameRequired': '名称不能为空',
    'inbox.setCategory': '设置分类',
    'inbox.category': '分类',
    'inbox.detail': '详情',
    'inbox.delete': '删除',
    'inbox.deleteConfirm': '确定删除任务「{title}」？',
    'inbox.empty': '收集盒为空，点击 + 添加',
    'inbox.selectCategory': '选择分类',
    'inbox.noCategory': '不分类',
    'inbox.title': '📥 任务面板',
    'inbox.weekGoal': '周目标',
    'inbox.dayGoal': '日目标',
    'inbox.emptyWeekGoal': '本周暂无目标，去「年」视图分配任务',
    'inbox.emptyDayGoal': '今天暂无目标',
    'inbox.groupAllDay': '全天目标',
    'inbox.groupTimed': '时间点目标',
    'inbox.groupUnspecified': '未指定',
    'inbox.maxDepth': '子任务最多嵌套 {max} 层',
};

export type I18nMessages = typeof zh;
