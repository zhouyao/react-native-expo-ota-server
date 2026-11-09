import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, shadow, spacing } from '../theme';

function Tag({ label, value, tone = 'primary' }) {
  const toneStyle =
    tone === 'success'
      ? { bg: colors.successSoft, fg: colors.success }
      : tone === 'warning'
        ? { bg: colors.warningSoft, fg: colors.warning }
        : { bg: colors.primarySoft, fg: colors.primary };
  return (
    <View style={[styles.tag, { backgroundColor: toneStyle.bg }]}>
      <Text style={[styles.tagLabel, { color: toneStyle.fg }]}>{label}</Text>
      {value ? <Text style={styles.tagValue}>{value}</Text> : null}
    </View>
  );
}

export default function CapabilityRow({ channel, rollout, served, signed }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>本次更新能力</Text>
      <View style={styles.row}>
        <Tag label="通道" value={channel || '-'} />
        <Tag label="灰度" value={`${typeof rollout === 'number' ? rollout : 0}%`} tone="warning" />
        <Tag label="签名" value={signed ? '已校验' : '未启用'} tone="success" />
        <Tag label="命中" value={served || '-'} />
      </View>
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
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
    marginBottom: 8,
  },
  tagLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  tagValue: {
    fontSize: 11,
    color: colors.text,
    marginLeft: 5,
  },
});
