import { StyleSheet, Text, View } from 'react-native';

/**
 * Auth screen scaffold — UI in a later sprint.
 */
export default function LoginScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>Login</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 18,
  },
});
