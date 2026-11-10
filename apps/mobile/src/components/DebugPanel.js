import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, shadow, spacing } from '../theme';

export function DebugRow({ label, value, warn = false, multiline = false }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text
        style={[styles.value, warn ? styles.valueWarn : null]}
        selectable
        numberOfLines={multiline ? undefined : 1}
      >
        {String(value ?? '-')}
      </Text>
    </View>
  );
}

/**
 * 调试面板：收起时也能在标题右侧看到关键摘要（运行通道 + 版本），
 * 展开后按分组展示，避免一次性铺满整屏。
 */
export default function DebugPanel({ children, summary, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={styles.card}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.head}>
        <Text style={styles.title}>调试信息</Text>
        <View style={styles.headRight}>
          {summary ? (
            <Text style={styles.summary} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
          <Text style={styles.toggle}>{open ? '收起' : '展开'}</Text>
        </View>
      </Pressable>
      {open ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: spacing.card,
    marginBottom: spacing.gap,
    ...shadow,
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    marginLeft: 12,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  summary: {
    fontSize: 12,
    color: colors.muted,
    marginRight: 10,
  },
  toggle: {
    fontSize: 13,
    color: colors.primary,
  },
  body: {
    marginTop: 10,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  label: {
    fontSize: 12,
    color: colors.muted,
  },
  value: {
    fontSize: 12,
    color: colors.text,
    flexShrink: 1,
    marginLeft: 12,
    textAlign: 'right',
  },
  valueWarn: {
    color: colors.warning,
  },
});
