import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

/** 调试面板内的分组：标题 + 可选说明 + 右上角操作（如刷新）。 */
export default function DebugSection({ title, hint, action, children }) {
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        {action || null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  hint: {
    marginTop: 4,
    fontSize: 11,
    lineHeight: 16,
    color: colors.faint,
  },
  body: {
    marginTop: 6,
  },
});
