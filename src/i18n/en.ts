// English messages
import type { I18nMessages } from './zh';

export const en: I18nMessages = {
    // Common
    'common.cancel': 'Cancel',
    'common.confirm': 'Confirm',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.select': 'Select',
    'common.clear': 'Clear',
    'common.add': 'Add',
    'common.apply': 'Apply',

    // Weekdays
    'week.monday': 'Mon',
    'week.tuesday': 'Tue',
    'week.wednesday': 'Wed',
    'week.thursday': 'Thu',
    'week.friday': 'Fri',
    'week.saturday': 'Sat',
    'week.sunday': 'Sun',

    // View
    'view.title': 'Week Schedule',

    // Main navigation (tab button group)
    'nav.year': 'Year',
    'nav.week': 'Week Plan',
    'nav.today': 'Today',
    'nav.swimlane': 'Swimlane',
    'nav.achievement': 'Achievements',
    'nav.placeholder': 'This is the "{name}" page',

    // Today view
    'today.start': 'Start',
    'today.detailTitle': 'Task Details',
    'today.noSelection': 'Select a task on the left or an event on the timeline to view details',
    'today.noDescription': 'No description',
    'today.category': 'Category',
    'today.timeRange': 'Time',
    'today.allDay': 'All day',
    'today.complete': 'Complete Planned Task',
    'today.replace': 'Replace with Another Task',
    'today.execUnplanned': 'Execute Unplanned Task',
    'today.execPlanned': 'Execute Planned',
    'today.replacePlanned': 'Replace Planned',
    'today.completeDone': 'Recorded execution of "{title}"',
    'today.replaceNeedEvent': 'Select an event on the timeline to replace first',
    'today.replaceDone': 'Replaced the event with "{title}"',

    // Year view
    'year.weekLabel': 'Week {week}',
    'year.monthLabel': '{month}',
    'year.thisYear': 'This year',
    'year.assigned': 'Assigned "{title}" to {week}',
    // Swimlane
    'swimlane.weekLabel': 'W{week}',
    'swimlane.legendPlan': 'Planned',
    'swimlane.legendExec': 'Executed',
    'year.unassigned': 'Unassigned "{title}" from {week}',

    // Command and ribbon
    'command.open': 'Open week schedule panel',
    'ribbon.open': 'Open week schedule',

    // Default categories
    'defaultCategory.work': 'Work',
    'defaultCategory.rest': 'Rest',
    'defaultCategory.play': 'Play',
    'defaultCategory.uncategorized': 'Uncategorized',

    // Settings
    'settings.title': 'Parrot Plan Settings',
    'settings.about': 'A weekly schedule planner: time block planning, event scheduling, and execution tracking.',
    'settings.data': 'Data',
    'settings.clearData': 'Clear data',
    'settings.clearDataDesc': 'Delete all tasks, events, time ranges and settings, restoring defaults. This cannot be undone.',
    'settings.clearDataConfirm': 'Clear all data?',
    'settings.clearDataConfirmDesc': 'All data will be permanently deleted and cannot be recovered.',
    'settings.clearDataDone': 'Data cleared',
    'settings.confirm': 'Confirm',
    'settings.cancel': 'Cancel',

    // All-day events
    'allday.label': 'All day',
    'allday.needSelect': 'Please select a task in the inbox first',
    'allday.added': 'Added all-day event "{title}"',
    'allday.empty': 'None',

    // Event layer
    'event.scheduled': 'Scheduled "{title}"',
    'event.alreadyScheduled': '"{title}" is already scheduled for that day',
    'event.edit': 'Edit Event',
    'event.create': 'New Event',
    'event.title': 'Title',
    'event.titlePlaceholder': 'Event name',
    'event.startTime': 'Start time',
    'event.endTime': 'End time',
    'event.category': 'Category',
    'event.noCategory': 'No category',
    'event.titleRequired': 'Title cannot be empty',

    // Time block
    'range.title': 'Time Block',
    'range.startTime': 'Start time',
    'range.endTime': 'End time',
    'range.category': 'Category',

    // Range scheme settings window
    'rangeScheme.open': 'Range Settings',
    'rangeScheme.title': 'Range Settings',
    'rangeScheme.switch': 'Switch Scheme',
    'rangeScheme.manage': 'Manage Schemes',
    'rangeScheme.manageTitle': 'Manage Schemes',
    'rangeScheme.new': 'New scheme',
    'rangeScheme.defaultName': 'Default scheme',
    'rangeScheme.namePlaceholder': 'Scheme name',
    'rangeScheme.empty': 'No schemes, click + to add',
    'rangeScheme.noActive': 'No scheme selected',
    'rangeScheme.switchTo': 'Switch',
    'rangeScheme.isDefault': 'Default',
    'rangeScheme.defaultLocked': 'Default scheme cannot be deleted',

    // Week navigation
    'weekNav.year': 'Year',
    'weekNav.week': 'Week',
    'weekNav.thisWeek': 'This week',

    // Category
    'category.legend': 'Time Block Legend',
    'category.config': 'Category Config',
    'category.new': 'New category',
    'category.empty': 'No categories, click + to add',
    'category.namePlaceholder': 'Category name',
    'category.uncategorizedLocked': 'Uncategorized cannot be deleted',

    // Template
    'template.title': 'Day Template',
    'template.selectFirst': 'Please select a template first',
    'template.notFound': 'Template not found',
    'template.create': 'New Day Template',
    'template.name': 'Template name',
    'template.namePlaceholder': 'e.g. Deep Work',
    'template.copyFrom': 'Copy from',
    'template.nameRequired': 'Please enter a template name',
    'template.unnamed': 'Unnamed template',
    'template.applyTo': 'Apply "{name}" to which days?',
    'template.selectAll': 'Select all',
    'template.clearAll': 'Clear',
    'template.selectAtLeastOne': 'Please select at least one day',
    'template.deleteTitle': 'Delete Template',
    'template.deleteConfirm': 'Delete template "{name}"?\n Time blocks already applied to the grid are not affected.',

    // Inbox
    'inbox.addTitle': 'Add to Inbox',
    'inbox.addSubTitle': 'Add subtask to "{title}"',
    'inbox.name': 'Name',
    'inbox.namePlaceholder': 'One-line summary',
    'inbox.desc': 'Description',
    'inbox.descPlaceholder': 'Additional notes (optional)',
    'inbox.nameRequired': 'Name cannot be empty',
    'inbox.setCategory': 'Set category',
    'inbox.category': 'Category',
    'inbox.detail': 'Details',
    'inbox.delete': 'Delete',
    'inbox.deleteConfirm': 'Delete task "{title}"?',
    'inbox.empty': 'Inbox is empty, click + to add',
    'inbox.selectCategory': 'Select category',
    'inbox.noCategory': 'No category',
    'inbox.title': '📥 Task Panel',
    'inbox.weekGoal': 'Week Goals',
    'inbox.dayGoal': 'Day Goals',
    'inbox.emptyWeekGoal': 'No goals this week. Assign tasks in the Year view.',
    'inbox.emptyDayGoal': 'No goals today.',
    'inbox.groupAllDay': 'All-day Goals',
    'inbox.groupTimed': 'Timed Goals',
    'inbox.groupUnspecified': 'Unspecified',
    'inbox.maxDepth': 'Subtasks can nest at most {max} levels',
};
