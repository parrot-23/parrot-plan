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
    'view.layer': 'Layer: ',
    'view.layer.timeRange': 'Time Block Layer',
    'view.layer.event': 'Event Layer',
    'view.layer.execution': 'Execution Layer',

    // All-day events
    'allday.label': 'All day',
    'allday.needSelect': 'Please select a task in the inbox first',
    'allday.added': 'Added all-day event "{title}"',

    // Event layer
    'event.scheduled': 'Scheduled "{title}"',
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

    // Category
    'category.legend': 'Time Block Legend',
    'category.config': 'Category Config',
    'category.new': 'New category',
    'category.empty': 'No categories, click + to add',
    'category.namePlaceholder': 'Category name',

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
    'inbox.name': 'Name',
    'inbox.namePlaceholder': 'One-line summary',
    'inbox.desc': 'Description',
    'inbox.descPlaceholder': 'Additional notes (optional)',
    'inbox.nameRequired': 'Name cannot be empty',
    'inbox.setCategory': 'Set category',
    'inbox.delete': 'Delete',
    'inbox.deleteConfirm': 'Delete task "{title}"?',
    'inbox.empty': 'Inbox is empty, click + to add',
    'inbox.selectCategory': 'Select category',
    'inbox.noCategory': 'No category',
    'inbox.title': '📥 Inbox',

    // Execution layer
    'exec.actual': 'Actually executed: {title}',
    'exec.count': 'Execution count: {count}',
    'exec.records': 'Task records',
    'exec.noRecords': 'No execution records',
    'exec.note': 'Note',
    'exec.notePlaceholder': 'Additional notes (optional)',
    'exec.confirm': 'Confirm execution',
    'exec.change': 'Change execution',
    'exec.actualTask': 'Actually executed task',
    'exec.noTasks': 'No tasks',
    'exec.newTaskPlaceholder': 'New task name',
    'exec.addTask': 'Add task',
    'exec.taskNameRequired': 'Please enter a task name',
    'exec.confirmChange': 'Confirm change',
    'exec.selectOrAdd': 'Please select or add a task',
};
