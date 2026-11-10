import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, shadow, spacing } from '../theme';

function Field({ label, value, mono }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, mono && styles.mono]} selectable numberOfLines={1}>
        {value || '-'}
      </Text>
    </View>
  );
}

export default function VersionCard({ releaseId, updateId, createdAt, serverEndpoint }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>当前版本</Text>
      <Field label="OTA 服务" value={serverEndpoint} mono />
      <Field label="releaseId" value={releaseId} mono />
      <Field label="updateId" value={updateId ? String(updateId).slice(0, 8) : '-'} mono />
      <Field label="发布时间" value={createdAt} />
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
    marginBottom: 10,
  },
  field: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  label: {
    fontSize: 13,
    color: colors.muted,
  },
  value: {
    fontSize: 13,
    color: colors.text,
    flexShrink: 1,
    marginLeft: 12,
    textAlign: 'right',
  },
  mono: {
    fontFamily: 'Menlo',
    fontSize: 12,
  },
});
